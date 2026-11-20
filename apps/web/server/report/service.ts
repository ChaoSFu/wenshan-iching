import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { runLocalTriage } from "@wenshan/content";
import { castFromTosses, lineLabel } from "@wenshan/iching-core";
import { corpus, topicsBundle } from "../content";
import { decrypt, decryptJson, encrypt } from "../crypto";
import { getDb } from "../db/client";
import { followups, orders, readings, reports, users } from "../db/schema";
import { env } from "../env";
import { HttpError } from "../http";
import { enqueue } from "../jobs/queue";
import { getMailer } from "../mail";
import { purgeReading, releaseReadingIfUnused, revokeOrderContent } from "../orders";
import { basisCast, readBasis, readIntent } from "../snapshot";
import type { FollowupContent, ReportContent } from "./schema";

export interface ReportView {
  id: string;
  orderId: string;
  createdAt: string;
  expiresAt: string;
  topicName: string;
  question: string;
  cast: { primaryName: string; changedName: string | null; moving: string[]; primary: number; changed: number | null; lines: number[] };
  content: ReportContent;
  citations: Record<string, { title: string; text: string; sourceUrl: string | null }>;
  followups: { id: string; seq: number; status: string; question: string; answer: FollowupContent | null }[];
  followupsRemaining: number;
  versions: Record<string, string>;
}

async function ownedReport(userId: string, reportId: string) {
  const db = await getDb();
  const [row] = await db
    .select({ report: reports, order: orders, reading: readings })
    .from(reports)
    .innerJoin(orders, eq(orders.id, reports.orderId))
    .leftJoin(readings, eq(readings.id, reports.readingId))
    .where(and(eq(reports.id, reportId), eq(reports.userId, userId)))
    .limit(1);
  if (!row) throw new HttpError(404, "not_found");
  return row;
}

/**
 * 报告页数据：只有本人、已交付、未删除、未过期的报告可看（PRD §8）。
 * 问题与卦象读订单快照；迁移前的旧报告没有快照，回退到阅读数据。
 */
export async function getReportView(userId: string, reportId: string): Promise<ReportView | { deleted: true; reason: string | null }> {
  const { report, order, reading } = await ownedReport(userId, reportId);
  if (report.deletedAt || !report.contentCt || order.status !== "delivered") {
    return { deleted: true, reason: report.deleteReason ?? order.status };
  }
  if (report.expiresAt.getTime() < Date.now()) return { deleted: true, reason: "expired" };

  const basis = readBasis(order);
  const intent = readIntent(order);
  const question = intent?.question ?? (reading?.questionCt ? decrypt(reading.questionCt) : null);
  const cast = basis ? basisCast(basis) : reading ? castFromTosses(reading.tosses) : null;
  if (question === null || !cast) return { deleted: true, reason: "content_unavailable" };
  const topicId = basis?.topicId ?? reading?.topicId;
  const topicName = basis?.topicName ?? topicsBundle.topics.find((t) => t.id === topicId)?.name ?? "";

  const db = await getDb();
  const snapshot = report.citationsSnapshotCt ? decryptJson<{ id: string; title: string; text: string }[]>(report.citationsSnapshotCt) : [];
  const citations: ReportView["citations"] = {};
  for (const s of snapshot) {
    const e = corpus.entries[s.id];
    citations[s.id] = {
      title: s.title,
      text: s.text,
      sourceUrl: e ? (corpus.hexagrams[String(e.hexagram)]?.sourcePermalink ?? null) : null,
    };
  }
  const fus = await db.select().from(followups).where(eq(followups.orderId, order.id)).orderBy(asc(followups.seq));
  const yang = (pos: number) => cast.lines[pos - 1] === 7 || cast.lines[pos - 1] === 9;
  return {
    id: report.id,
    orderId: order.id,
    createdAt: report.createdAt.toISOString(),
    expiresAt: report.expiresAt.toISOString(),
    topicName,
    question,
    cast: {
      primary: cast.primary,
      changed: cast.changed,
      lines: cast.lines,
      primaryName: corpus.hexagrams[String(cast.primary)]?.name ?? "",
      changedName: cast.changed ? (corpus.hexagrams[String(cast.changed)]?.name ?? null) : null,
      moving: cast.movingLines.map((p) => lineLabel(p, yang(p))),
    },
    content: decryptJson<ReportContent>(report.contentCt),
    citations,
    followups: fus
      .filter((f) => f.questionCt)
      .map((f) => ({
        id: f.id,
        seq: f.seq,
        status: f.status,
        question: decrypt(f.questionCt!),
        answer: f.answerCt ? decryptJson<FollowupContent>(f.answerCt) : null,
      })),
    followupsRemaining: Math.max(0, order.followupsTotal - order.followupsUsed),
    versions: report.versions as Record<string, string>,
  };
}

/**
 * 用户随时删除：清除这笔订单的报告、追问、快照里的个人内容，以及这一卦的问题、背景和分流摘要；
 * 同一卦其他订单快照里的个人内容一并清除，未完成的结账作废。账务字段保留（PRD §8）。
 */
export async function deleteReport(userId: string, reportId: string): Promise<void> {
  const { order } = await ownedReport(userId, reportId);
  const db = await getDb();
  await db.transaction(async (tx) => {
    await revokeOrderContent(tx, order.id, "user_deleted");
    const now = new Date();
    await tx
      .update(orders)
      .set({ intentCt: null, contentPurgedAt: now, updatedAt: now })
      .where(eq(orders.readingId, order.readingId));
    await tx
      .update(orders)
      .set({ status: "expired", updatedAt: now })
      .where(and(eq(orders.readingId, order.readingId), eq(orders.status, "pending_payment")));
    await purgeReading(tx, order.readingId);
  });
}

export type FollowupSubmitResult =
  | { status: "queued"; followupId: string }
  | { status: "crisis"; message: string };

export async function submitFollowup(userId: string, reportId: string, question: string, idempotencyKey: string): Promise<FollowupSubmitResult> {
  const { report, order } = await ownedReport(userId, reportId);
  if (report.deletedAt || !report.contentCt || order.status !== "delivered" || report.expiresAt.getTime() < Date.now()) {
    throw new HttpError(409, "report_unavailable", "这份报告已不可追问");
  }
  const local = runLocalTriage(question, topicsBundle.triage);
  if (local.crisis) return { status: "crisis", message: local.notices[0]?.message ?? "" };

  const db = await getDb();
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: followups.id })
      .from(followups)
      .where(and(eq(followups.orderId, order.id), eq(followups.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (existing) return { status: "queued" as const, followupId: existing.id };

    // 先占用一次次数：条件更新保证并发提交也不会超过三次
    const [reserved] = await tx
      .update(orders)
      .set({ followupsUsed: sql`${orders.followupsUsed} + 1`, updatedAt: new Date() })
      .where(and(eq(orders.id, order.id), eq(orders.status, "delivered"), lt(orders.followupsUsed, orders.followupsTotal)))
      .returning({ used: orders.followupsUsed });
    if (!reserved) throw new HttpError(409, "no_followups_left", "三次追问已经用完");

    const [f] = await tx
      .insert(followups)
      .values({ orderId: order.id, seq: reserved.used, idempotencyKey, questionCt: encrypt(question) })
      .returning({ id: followups.id });
    await enqueue(tx, "generate_followup", { followupId: f!.id });
    return { status: "queued" as const, followupId: f!.id };
  });
}

/** 报告到期（默认交付后 90 天）自动清除内容；没有其他有效订单时，这一卦的问题也一并清除 */
export async function purgeExpiredReports(): Promise<number> {
  const db = await getDb();
  const expired = await db
    .select({ orderId: reports.orderId, readingId: reports.readingId })
    .from(reports)
    .where(and(isNull(reports.deletedAt), lt(reports.expiresAt, new Date())))
    .limit(200);
  for (const { orderId, readingId } of expired) {
    await db.transaction(async (tx) => {
      await revokeOrderContent(tx, orderId, "expired");
      await releaseReadingIfUnused(tx, readingId);
    });
  }
  return expired.length;
}

/** 交付通知邮件：只含链接，不含问题与报告内容 */
export async function sendReportReadyEmail(orderId: string): Promise<void> {
  const db = await getDb();
  const [row] = await db
    .select({ email: users.email, status: orders.status })
    .from(orders)
    .innerJoin(users, eq(users.id, orders.userId))
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!row || row.status !== "delivered") return;
  const support = env().SUPPORT_EMAIL;
  await getMailer().send({
    to: row.email,
    subject: "你的问山报告已生成",
    text: [
      `你的报告已经生成，可以随时回来查看：\n${env().APP_URL}/orders/${orderId}`,
      `报告保留 ${env().REPORT_RETENTION_DAYS} 天，到期前可以导出，也可以随时删除。`,
      `付款或报告有问题，可以在这里反馈：${env().APP_URL}/support?type=paid_not_delivered&order=${orderId}`,
      support ? `网站无法打开时，请发邮件到 ${support}，并附上订单号 ${orderId}。` : null,
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
}
