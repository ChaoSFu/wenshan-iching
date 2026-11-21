import { requireCapability } from "../capabilities";
import { and, asc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { reportRules } from "../content";
import { decrypt, decryptJson, encryptJson, safetyIdentifier } from "../crypto";
import { getDb } from "../db/client";
import { followups, orders, reports } from "../db/schema";
import { env } from "../env";
import { enqueue } from "../jobs/queue";
import { requestRefund } from "../refunds";
import { getLlm, routeConfig } from "../llm";
import { recordTransportFailures, recordUsage } from "../llm/usage";
import { basisCast, readBasis, readIntent, type OrderBasis, type OrderIntent } from "../snapshot";
import { FOLLOWUP_CALLS_PER_RUN, REPORT_CALLS_PER_RUN, attemptFollowup, attemptReport } from "./attempts";
import { type AllowedPassage } from "./passages";
import { PROMPT_VERSION, type UserSituation } from "./prompt";
import { FOLLOWUP_SCHEMA_VERSION, REPORT_SCHEMA_VERSION, type ReportContent } from "./schema";
import { VALIDATOR_VERSION, type ValidationContext } from "./validate";

const CALLS_PER_RUN = REPORT_CALLS_PER_RUN;
const FOLLOWUP_CALLS = FOLLOWUP_CALLS_PER_RUN;

/** 订单快照还原成提示词里的用户处境（履约与评测共用） */
export function situationOf(basis: OrderBasis, intent: OrderIntent): UserSituation {
  return {
    topicId: basis.topicId,
    question: intent.question,
    context: intent.context,
    summary: intent.summary,
    missingInfo: intent.missingInfo,
  };
}

function contentVersion(basis: OrderBasis): string {
  return `${basis.corpusVersion}|${basis.topicId}@${basis.topicVersion}|${basis.contentMode}`;
}

export function validationContext(passages: AllowedPassage[], s: UserSituation): ValidationContext {
  const rules = reportRules(s.topicId);
  return {
    allowedIds: new Set(passages.map((p) => p.id)),
    quotableSources: [
      ...passages.flatMap((p) => [p.text, p.vernacular ?? ""]),
      s.question,
      ...Object.values(s.context),
      s.summary ?? "",
      // 主题自己的报告要求被引用不算错引
      ...rules.report.mustVerify,
      ...rules.report.deliverables,
    ],
  };
}

async function failOrder(orderId: string, reason: string, refundNow: boolean): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(orders)
      .set({ status: refundNow ? "refund_pending" : "generation_failed", failureReason: reason, updatedAt: new Date() })
      .where(and(eq(orders.id, orderId), inArray(orders.status, ["paid", "generating", "generation_failed"])))
      .returning({ id: orders.id });
    if (updated.length && refundNow) await requestRefund(tx, orderId, { reason, requestedBy: "system" });
  });
  console.error(`[report] order ${orderId} failed: ${reason}`);
}

/** 占用一次模型调用额度；返回 false 表示这笔订单已达上限（持久化计数，跨重试、跨进程有效） */
async function reserveCall(orderId: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .update(orders)
    .set({ generationCalls: sql`${orders.generationCalls} + 1` })
    .where(and(eq(orders.id, orderId), lt(orders.generationCalls, env().MAX_REPORT_CALLS_PER_ORDER)))
    .returning({ id: orders.id });
  return rows.length > 0;
}

/** 任务 generate_report：只读订单快照 → 一次结构化生成 → 校验（失败重试一次）→ 同一事务内交付 */
export async function generateReport(orderId: string): Promise<"delivered" | "failed" | "skipped" | "discarded"> {
  // 履约所需的模型配置先检查：缺配置时任务延后，订单状态与调用次数都不变
  requireCapability("llm");
  const db = await getDb();
  const [order] = await db
    .update(orders)
    .set({ status: "generating", updatedAt: new Date() })
    .where(and(eq(orders.id, orderId), inArray(orders.status, ["paid", "generating", "generation_failed"])))
    .returning();
  if (!order) return "skipped"; // 已交付、已退款、拒付、待核实等

  const basis = readBasis(order);
  const intent = readIntent(order);
  if (!basis || !intent) {
    // 没有题意快照的旧订单：不凭猜测生成，交给运营
    await db
      .update(orders)
      .set({ status: "needs_review", reviewReason: "legacy_intent_unrecoverable", updatedAt: new Date() })
      .where(and(eq(orders.id, orderId), eq(orders.status, "generating")));
    return "failed";
  }

  const s = situationOf(basis, intent);
  const started = Date.now();
  const usage = { kind: "report" as const, orderId, readingId: order.readingId, promptVersion: PROMPT_VERSION, contentVersion: contentVersion(basis) };
  const run = await attemptReport({
    llm: getLlm(),
    topicId: basis.topicId,
    cast: basisCast(basis),
    passages: basis.passages,
    situation: s,
    ctx: validationContext(basis.passages, s),
    safetyIdentifier: safetyIdentifier(order.userId),
    calls: CALLS_PER_RUN,
    routeHint: routeConfig("report"),
    hooks: {
      reserve: () => reserveCall(orderId),
      onAttempt: (a) => recordUsage({ ...usage, result: a.result, issues: a.issues, moderationCategories: a.moderationCategories }),
      onTransportExhausted: (failures, route) => recordTransportFailures(usage, route.model, route.effort, failures),
    },
  });

  if (run.status === "ok") {
    return deliver(order.id, order.userId, order.readingId, basis, run.content, {
      model: run.result.model,
      reasoningEffort: run.result.effort,
      attempts: order.generationCalls + run.attempts.length,
      latencyMs: Date.now() - started,
    });
  }
  if (run.status === "refusal") {
    // 拒答按分流升级处理：不交付，立即退款（技术方案 5.7）
    await failOrder(orderId, "model_refusal", true);
    return "failed";
  }
  if (run.status === "call_limit") {
    await failOrder(orderId, "call_limit_reached", false);
    return "failed";
  }
  await failOrder(orderId, "validation_failed", false);
  return "failed";
}

/**
 * 交付：先确认订单仍在生成中（没有被退款、拒付），再在同一事务里写报告、改状态、入队通知。
 * 退款先生效时，晚到的生成结果直接丢弃。
 */
async function deliver(
  orderId: string,
  userId: string,
  readingId: string,
  basis: OrderBasis,
  content: ReportContent,
  meta: { model: string; reasoningEffort: string; attempts: number; latencyMs: number },
): Promise<"delivered" | "discarded"> {
  const db = await getDb();
  const cited = [...new Set(content.observations.flatMap((o) => o.citations))];
  const snapshot = basis.passages.filter((p) => cited.includes(p.id)).map((p) => ({ id: p.id, title: p.title, text: p.text }));
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(orders)
      .set({ status: "delivered", deliveredAt: new Date(), failureReason: null, updatedAt: new Date() })
      .where(and(eq(orders.id, orderId), eq(orders.status, "generating"), isNull(orders.contentPurgedAt)))
      .returning({ id: orders.id });
    if (!updated.length) {
      console.warn(`[report] order ${orderId} is no longer deliverable; generated report discarded`);
      return "discarded" as const;
    }
    await tx.insert(reports).values({
      orderId,
      userId,
      readingId,
      contentCt: encryptJson(content),
      citations: cited,
      citationsSnapshotCt: encryptJson(snapshot),
      versions: {
        topic: `${basis.topicId}@${basis.topicVersion}`,
        cast: basis.cast.ruleVersion,
        selection: basis.selectionVersion,
        corpus: basis.corpusVersion,
        contentMode: basis.contentMode,
        triage: basis.triage.version,
        prompt: PROMPT_VERSION,
        schema: REPORT_SCHEMA_VERSION,
        validator: VALIDATOR_VERSION,
        model: meta.model,
        reasoningEffort: meta.reasoningEffort,
      },
      attempts: meta.attempts,
      latencyMs: meta.latencyMs,
      expiresAt: new Date(Date.now() + env().REPORT_RETENTION_DAYS * 24 * 3600_000),
    });
    await enqueue(tx, "send_report_ready_email", { orderId }, { dedupeKey: `ready-mail:${orderId}` });
    return "delivered" as const;
  });
}

/** 生成任务彻底失败（例如模型服务长时间不可用）：标为生成异常，等待后台重试或到期自动退款 */
export async function onReportJobExhausted(orderId: string): Promise<void> {
  await failOrder(orderId, "llm_unavailable", false);
}

const RETRY_EVERY_MS = 30 * 60_000;

/**
 * 生成异常的订单在退款期限前定期重新生成（PRD §8：后台自动重试，用户无需再付款）。
 * 拒答、原文缺失等不会自行好转的原因不重试；调用次数达到上限的也不再重试，等到期退款。
 */
export async function retryFailedGenerations(): Promise<number> {
  const db = await getDb();
  const now = Date.now();
  const due = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.status, "generation_failed"),
        inArray(orders.failureReason, ["validation_failed", "llm_unavailable"]),
        lt(orders.generationCalls, env().MAX_REPORT_CALLS_PER_ORDER),
        sql`${orders.updatedAt} < now() - interval '15 minutes'`,
        sql`${orders.refundDueAt} > now()`,
      ),
    );
  for (const { id } of due) {
    await enqueue(db, "generate_report", { orderId: id }, { dedupeKey: `report:${id}:${Math.floor(now / RETRY_EVERY_MS)}` });
  }
  return due.length;
}

// ---------- 追问 ----------

/** 订单仍可追问：已交付、内容未清除、报告未删除且未过期 */
function orderStillOpen(orderId: string) {
  return and(
    eq(orders.id, orderId),
    eq(orders.status, "delivered"),
    isNull(orders.contentPurgedAt),
    sql`exists (select 1 from ${reports} r where r.order_id = ${orders.id} and r.deleted_at is null and r.content_ct is not null and r.expires_at > now())`,
  );
}

/**
 * 结算一次没有产生回答的追问（不是同一件事、生成失败）并退还次数（技术方案 5.8）。
 * 只有从 queued 转出的那一次才退还；订单已退款、删除或报告到期时不再改动次数。
 */
async function releaseFollowup(followupId: string, orderId: string, status: "rejected" | "failed", answer?: unknown): Promise<boolean> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const settled = await tx
      .update(followups)
      .set({ status, answerCt: answer ? encryptJson(answer) : null, updatedAt: new Date() })
      .where(and(eq(followups.id, followupId), eq(followups.status, "queued")))
      .returning({ id: followups.id });
    if (!settled.length) return false;
    await tx
      .update(orders)
      .set({ followupsUsed: sql`greatest(${orders.followupsUsed} - 1, 0)`, updatedAt: new Date() })
      .where(and(orderStillOpen(orderId), gt(orders.followupsUsed, 0)));
    return true;
  });
}

export async function generateFollowup(followupId: string): Promise<unknown> {
  requireCapability("llm");
  const db = await getDb();
  const [f] = await db.select().from(followups).where(eq(followups.id, followupId)).limit(1);
  if (!f || f.status !== "queued" || !f.questionCt) return;
  const [order] = await db.select().from(orders).where(eq(orders.id, f.orderId)).limit(1);
  const [report] = await db
    .select()
    .from(reports)
    .where(and(eq(reports.orderId, f.orderId), isNull(reports.deletedAt)))
    .limit(1);
  const basis = order ? readBasis(order) : null;
  const intent = order ? readIntent(order) : null;
  if (!order || order.status !== "delivered" || !report?.contentCt || !basis || !intent) {
    return releaseFollowup(f.id, f.orderId, "failed");
  }

  const s = situationOf(basis, intent);
  const ctx = validationContext(basis.passages, s);
  const question = decrypt(f.questionCt);
  ctx.quotableSources.push(question);
  const previousRows = await db
    .select()
    .from(followups)
    .where(and(eq(followups.orderId, f.orderId), eq(followups.status, "done")))
    .orderBy(asc(followups.seq));
  const previous = previousRows
    .filter((p) => p.questionCt && p.answerCt)
    .map((p) => ({ question: decrypt(p.questionCt!), answer: decryptJson<{ answer: string }>(p.answerCt!).answer }));

  const usage = { kind: "followup" as const, orderId: f.orderId, readingId: order.readingId, promptVersion: PROMPT_VERSION, contentVersion: contentVersion(basis) };
  const run = await attemptFollowup({
    llm: getLlm(),
    topicId: basis.topicId,
    cast: basisCast(basis),
    passages: basis.passages,
    situation: s,
    ctx,
    safetyIdentifier: safetyIdentifier(order.userId),
    calls: FOLLOWUP_CALLS,
    routeHint: routeConfig("followup"),
    report: decryptJson<ReportContent>(report.contentCt),
    previous,
    question,
    hooks: {
      onAttempt: (a) => recordUsage({ ...usage, result: a.result, issues: a.issues, moderationCategories: a.moderationCategories }),
      onTransportExhausted: (failures, route) => recordTransportFailures(usage, route.model, route.effort, failures),
    },
  });
  if (run.status !== "ok") return releaseFollowup(f.id, f.orderId, "failed");
  if (!run.content.is_same_matter) return releaseFollowup(f.id, f.orderId, "rejected", run.content);
  // 原子结算：追问仍是 queued，且订单仍可追问（未退款、未删除、报告未到期）才写回答；
  // 否则丢弃结果，不改次数（退款、删除时次数已无意义）
  await db
    .update(followups)
    .set({
      status: "done",
      answerCt: encryptJson(run.content),
      versions: { prompt: PROMPT_VERSION, schema: FOLLOWUP_SCHEMA_VERSION, validator: VALIDATOR_VERSION, model: run.result.model, effort: run.result.effort },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(followups.id, f.id),
        eq(followups.status, "queued"),
        sql`exists (select 1 from ${orders} o where o.id = ${followups.orderId} and o.status = 'delivered' and o.content_purged_at is null)`,
        sql`exists (select 1 from ${reports} r where r.order_id = ${followups.orderId} and r.deleted_at is null and r.content_ct is not null and r.expires_at > now())`,
      ),
    );
}

export async function onFollowupJobExhausted(followupId: string): Promise<void> {
  const db = await getDb();
  const [f] = await db.select().from(followups).where(eq(followups.id, followupId)).limit(1);
  if (f && f.status === "queued") await releaseFollowup(f.id, f.orderId, "failed");
}
