import { requireCapability } from "./capabilities";
import { randomInt } from "node:crypto";
import { and, desc, eq, gt, ilike, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import pkg from "../package.json";
import { emailSchema, type SessionUser } from "./auth";
import { corpus } from "./content";
import { decrypt, encrypt, keyedHash } from "./crypto";
import { getDb } from "./db/client";
import { jobs, opsActions, orders, readings, reports, supportTickets, TICKET_CATEGORIES, TICKET_STATUSES, type TicketCategory, type TicketStatus } from "./db/schema";
import { env } from "./env";
import { HttpError } from "./http";
import { DeferJobError, enqueue } from "./jobs/queue";
import { NOTIFY_CLAIM_MS } from "./notify-claim";
import { getMailer } from "./mail";
import { readIntent } from "./snapshot";

/**
 * 用户反馈工单（/support）。先持久化、给出工单号，运营通知异步发送；
 * 不依赖模型和支付服务，它们故障时照样受理。描述、联系邮箱、问卦原文以密文保存。
 */

export const APP_VERSION = `${pkg.version}+${corpus.version}`;
export const REPORT_ISSUES = ["bad_citation", "misunderstood", "vague_action"] as const;

export const supportSubmitSchema = z.object({
  idempotencyKey: z.string().min(8).max(64),
  category: z.enum(TICKET_CATEGORIES),
  reportIssues: z.array(z.enum(REPORT_ISSUES)).max(3).default([]),
  description: z.string().trim().min(5, "请描述一下发生了什么（至少 5 个字）").max(2000),
  contactEmail: z.string().trim().max(254).optional(),
  orderId: z.uuid().optional(),
  reportId: z.uuid().optional(),
  includeQuestion: z.boolean().default(false),
  diagnostics: z
    .object({ page: z.string().max(200).optional(), errorCode: z.string().max(80).optional() })
    .default({}),
});
export type SupportSubmitInput = z.infer<typeof supportSubmitSchema>;

const LIMIT_PER_IP_PER_HOUR = 5;
const LIMIT_PER_USER_PER_HOUR = 10;

function ticketNo(): string {
  const d = new Date();
  const date = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const tail = Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join("");
  return `WS-${date}-${tail}`;
}

/** 页面路径只保留 pathname，去掉查询参数，避免带出个人信息 */
function cleanPage(page?: string): string | undefined {
  if (!page) return undefined;
  try {
    return new URL(page, "http://x").pathname.slice(0, 200);
  } catch {
    return undefined;
  }
}

export async function submitTicket(
  input: SupportSubmitInput,
  ctx: { user: SessionUser | null; ip: string },
): Promise<{ ticketNo: string; linkedOrder: boolean; linkedReport: boolean }> {
  const db = await getDb();
  const ipHash = keyedHash("ip", ctx.ip);

  const [dup] = await db.select().from(supportTickets).where(eq(supportTickets.idempotencyKey, input.idempotencyKey)).limit(1);
  if (dup) return { ticketNo: dup.ticketNo, linkedOrder: Boolean(dup.orderId), linkedReport: Boolean(dup.reportId) };

  const hourAgo = new Date(Date.now() - 3600_000);
  const [byIp] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(supportTickets)
    .where(and(eq(supportTickets.ipHash, ipHash), gt(supportTickets.createdAt, hourAgo)));
  if ((byIp?.n ?? 0) >= LIMIT_PER_IP_PER_HOUR && !ctx.user) throw new HttpError(429, "too_many_requests", "提交太频繁，请稍后再试");
  if (ctx.user) {
    const [byUser] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(supportTickets)
      .where(and(eq(supportTickets.userId, ctx.user.id), gt(supportTickets.createdAt, hourAgo)));
    if ((byUser?.n ?? 0) >= LIMIT_PER_USER_PER_HOUR) throw new HttpError(429, "too_many_requests", "提交太频繁，请稍后再试");
  }

  let contactEmail: string | null = null;
  if (input.contactEmail) {
    const parsed = emailSchema.safeParse(input.contactEmail);
    if (!parsed.success) throw new HttpError(400, "invalid_email", "回复邮箱格式不对");
    contactEmail = parsed.data;
  }

  // 关联订单或报告：只在服务端确认属于当前登录用户时才关联
  let orderId: string | null = null;
  let reportId: string | null = null;
  let reportVersions: Record<string, unknown> | null = null;
  if (ctx.user && input.reportId) {
    const [r] = await db
      .select({ id: reports.id, orderId: reports.orderId, versions: reports.versions })
      .from(reports)
      .where(and(eq(reports.id, input.reportId), eq(reports.userId, ctx.user.id)))
      .limit(1);
    if (r) {
      reportId = r.id;
      orderId = r.orderId;
      reportVersions = r.versions as Record<string, unknown>;
    }
  }
  if (ctx.user && !orderId && input.orderId) {
    const [o] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.id, input.orderId), eq(orders.userId, ctx.user.id)))
      .limit(1);
    if (o) orderId = o.id;
  }
  // 问卦原文由用户自己决定是否附上；读取与写入放在同一事务、订单行锁下（见下方），
  // 与删除、退款撤回竞争时，删除完成后不会再把已清除的原文写进工单（附录 F.5）
  const withQuestion = Boolean(input.includeQuestion && orderId);

  const diagnostics = {
    page: cleanPage(input.diagnostics.page),
    errorCode: input.diagnostics.errorCode,
    appVersion: APP_VERSION,
    loggedIn: Boolean(ctx.user),
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const no = ticketNo();
    try {
      const created = await db.transaction(async (tx) => {
        let question: string | null = null;
        if (withQuestion && orderId) {
          const [o] = await tx
            .select({ intentCt: orders.intentCt, purged: orders.contentPurgedAt, readingId: orders.readingId })
            .from(orders)
            .where(eq(orders.id, orderId))
            .for("update")
            .limit(1);
          if (o && !o.purged) {
            const [r] = await tx.select({ q: readings.questionCt, deleted: readings.deletedAt }).from(readings).where(eq(readings.id, o.readingId)).limit(1);
            question = readIntent(o)?.question ?? (r?.q && !r.deleted ? decrypt(r.q) : null);
          }
        }
        const [t] = await tx
          .insert(supportTickets)
          .values({
            ticketNo: no,
            idempotencyKey: input.idempotencyKey,
            category: input.category,
            reportIssues: input.category === "report_content" ? input.reportIssues : [],
            descriptionCt: encrypt(input.description),
            contactEmailCt: contactEmail ? encrypt(contactEmail) : null,
            userId: ctx.user?.id ?? null,
            orderId,
            reportId,
            diagnostics,
            reportVersions,
            questionCt: question ? encrypt(question) : null,
            ipHash,
          })
          .onConflictDoNothing({ target: supportTickets.idempotencyKey })
          .returning({ id: supportTickets.id, ticketNo: supportTickets.ticketNo });
        if (!t) return null;
        await enqueue(tx, "notify_support_ticket", { ticketId: t.id }, { dedupeKey: `ticket-notify:${t.id}` });
        return t;
      });
      if (!created) {
        const [again] = await db.select().from(supportTickets).where(eq(supportTickets.idempotencyKey, input.idempotencyKey)).limit(1);
        return { ticketNo: again!.ticketNo, linkedOrder: Boolean(again!.orderId), linkedReport: Boolean(again!.reportId) };
      }
      return { ticketNo: created.ticketNo, linkedOrder: Boolean(orderId), linkedReport: Boolean(reportId) };
    } catch (err) {
      // 工单号撞车（极少见）时换一个重试
      if (attempt === 2 || !String((err as Error).message).includes("ticket_no")) throw err;
    }
  }
  throw new Error("unreachable");
}

/**
 * 任务 notify_support_ticket：通知运营邮箱。失败会重试，不影响工单本身。
 * 与交付通知一样区分认领与"邮件服务已接受"，并带稳定幂等键（附录 F.4）。
 */
export async function notifySupportTicket(ticketId: string): Promise<void> {
  const db = await getDb();
  const [t] = await db.select().from(supportTickets).where(eq(supportTickets.id, ticketId)).limit(1);
  if (!t || t.notifiedAt) return;
  const to = env().SUPPORT_NOTIFY_EMAIL;
  // 没配置运营邮箱：不发通知，工单只在后台列表里看（notifiedAt 保持为空，如实显示"未发通知"）
  if (!to) return;
  // 通知配置单独校验：邮件不可用时任务延后，工单本身早已受理
  requireCapability("mail");
  const claimedAt = new Date();
  const claimed = await db
    .update(supportTickets)
    .set({ notifyClaimedAt: claimedAt })
    .where(
      and(
        eq(supportTickets.id, ticketId),
        isNull(supportTickets.notifiedAt),
        sql`(${supportTickets.notifyClaimedAt} is null or ${supportTickets.notifyClaimedAt} < now() - make_interval(secs => ${NOTIFY_CLAIM_MS / 1000}))`,
      ),
    )
    .returning({ id: supportTickets.id });
  if (!claimed.length) {
    const [again] = await db.select({ notified: supportTickets.notifiedAt }).from(supportTickets).where(eq(supportTickets.id, ticketId));
    if (again?.notified) return;
    throw new DeferJobError(`ticket notification ${ticketId} is claimed by another run`, NOTIFY_CLAIM_MS);
  }
  try {
    await getMailer().send({
      to,
      subject: `[问山工单] ${t.ticketNo} · ${CATEGORY_LABEL[t.category]}`,
      idempotencyKey: `ticket-notify:${t.id}`,
      text: `新工单 ${t.ticketNo}（${CATEGORY_LABEL[t.category]}）。\n处理：${env().APP_URL}/ops?ticket=${t.ticketNo}\n\n为保护隐私，邮件不含用户描述，请在后台查看。`,
    });
  } catch (err) {
    await db
      .update(supportTickets)
      .set({ notifyClaimedAt: null })
      .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.notifyClaimedAt, claimedAt)));
    throw err;
  }
  await db.update(supportTickets).set({ notifiedAt: sql`now()`, notifyClaimedAt: null }).where(eq(supportTickets.id, ticketId));
}

/** 维护：最近 20 小时内（邮件幂等键的有效期内）的工单通知仍未被接受、也没有在途任务的，每 30 分钟补一次 */
export async function recoverTicketNotifications(): Promise<number> {
  if (!env().SUPPORT_NOTIFY_EMAIL) return 0;
  const db = await getDb();
  const rows = await db
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(
      and(
        isNull(supportTickets.notifiedAt),
        sql`${supportTickets.createdAt} > now() - interval '20 hours'`,
        sql`${supportTickets.createdAt} < now() - interval '5 minutes'`,
        sql`not exists (select 1 from ${jobs} j where j.kind = 'notify_support_ticket' and j.payload->>'ticketId' = ${supportTickets.id}::text and j.status in ('queued','running'))`,
      ),
    )
    .limit(100);
  const bucket = Math.floor(Date.now() / (30 * 60_000));
  for (const { id } of rows) await enqueue(db, "notify_support_ticket", { ticketId: id }, { dedupeKey: `ticket-notify:${id}:${bucket}` });
  return rows.length;
}

/**
 * 工单的保留规则（与报告的 90 天分开）：已解决超过 SUPPORT_RETENTION_DAYS 的工单，
 * 清除描述、联系邮箱和随附原文，只留编号、类型、状态和时间；运营操作记录的备注同期清除。
 */
export async function purgeOldTickets(): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - env().SUPPORT_RETENTION_DAYS * 24 * 3600_000);
  const rows = await db
    .update(supportTickets)
    .set({ descriptionCt: null, contactEmailCt: null, questionCt: null, purgedAt: new Date() })
    .where(and(eq(supportTickets.status, "resolved"), lt(supportTickets.resolvedAt, cutoff), isNull(supportTickets.purgedAt)))
    .returning({ id: supportTickets.id });
  await db.update(opsActions).set({ note: null }).where(and(lt(opsActions.createdAt, cutoff), sql`${opsActions.note} is not null`));
  return rows.length;
}

export const CATEGORY_LABEL: Record<TicketCategory, string> = {
  duplicate_charge_or_refund: "重复扣款或退款",
  paid_not_delivered: "已付款未收到报告",
  login_or_page_error: "登录或页面故障",
  report_content: "报告内容问题",
  other: "其他",
};

// ---------- 运营 ----------

export function isOps(user: SessionUser | null): boolean {
  if (!user) return false;
  const list = env()
    .OPS_EMAILS.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(user.email.toLowerCase());
}

export function requireOps(user: SessionUser | null): SessionUser {
  // 非运营用户与未登录一样返回 404，不暴露后台存在
  if (!user || !isOps(user)) throw new HttpError(404, "not_found");
  return user;
}

export interface TicketView {
  id: string;
  ticketNo: string;
  category: TicketCategory;
  categoryLabel: string;
  reportIssues: string[];
  status: TicketStatus;
  description: string;
  contactEmail: string | null;
  orderId: string | null;
  orderStatus: string | null;
  reportId: string | null;
  reportVersions: Record<string, unknown> | null;
  question: string | null;
  diagnostics: Record<string, unknown>;
  notified: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function listTickets(filter: { q?: string; category?: string; status?: string }): Promise<TicketView[]> {
  const db = await getDb();
  const conds: SQL[] = [];
  if (filter.q) conds.push(or(ilike(supportTickets.ticketNo, `%${filter.q.trim()}%`), sql`${supportTickets.orderId}::text = ${filter.q.trim()}`)!);
  if (filter.category && (TICKET_CATEGORIES as readonly string[]).includes(filter.category)) {
    conds.push(eq(supportTickets.category, filter.category as TicketCategory));
  }
  if (filter.status && (TICKET_STATUSES as readonly string[]).includes(filter.status)) {
    conds.push(eq(supportTickets.status, filter.status as TicketStatus));
  }
  const rows = await db
    .select({ t: supportTickets, orderStatus: orders.status })
    .from(supportTickets)
    .leftJoin(orders, eq(orders.id, supportTickets.orderId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(supportTickets.createdAt))
    .limit(100);
  return rows.map(({ t, orderStatus }) => ({
    id: t.id,
    ticketNo: t.ticketNo,
    category: t.category,
    categoryLabel: CATEGORY_LABEL[t.category],
    reportIssues: t.reportIssues as string[],
    status: t.status,
    description: t.descriptionCt ? decrypt(t.descriptionCt) : "",
    contactEmail: t.contactEmailCt ? decrypt(t.contactEmailCt) : null,
    orderId: t.orderId,
    orderStatus: orderStatus ?? null,
    reportId: t.reportId,
    reportVersions: (t.reportVersions as Record<string, unknown> | null) ?? null,
    question: t.questionCt ? decrypt(t.questionCt) : null,
    diagnostics: t.diagnostics as Record<string, unknown>,
    notified: Boolean(t.notifiedAt),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  }));
}

export async function updateTicketStatus(ticketId: string, status: TicketStatus, actor = "ops"): Promise<void> {
  const db = await getDb();
  const rows = await db
    .update(supportTickets)
    .set({ status, resolvedAt: status === "resolved" ? new Date() : null, updatedAt: new Date() })
    .where(eq(supportTickets.id, ticketId))
    .returning({ id: supportTickets.id, orderId: supportTickets.orderId });
  if (!rows.length) throw new HttpError(404, "not_found");
  const { recordOpsAction } = await import("./ops");
  await recordOpsAction({ actor, action: "ticket_status", ticketId, orderId: rows[0]!.orderId, result: status });
}
