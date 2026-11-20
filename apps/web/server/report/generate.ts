import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { reportRules } from "../content";
import { decrypt, decryptJson, encryptJson, safetyIdentifier } from "../crypto";
import { getDb } from "../db/client";
import { followups, orders, reports } from "../db/schema";
import { env } from "../env";
import { enqueue } from "../jobs/queue";
import { getLlm } from "../llm";
import { recordUsage } from "../llm/usage";
import { basisCast, readBasis, readIntent, type OrderBasis, type OrderIntent } from "../snapshot";
import { fakeFollowup, fakeReport } from "./fake";
import { castSummary, type AllowedPassage } from "./passages";
import {
  FOLLOWUP_DEVELOPER_SUFFIX,
  PROMPT_VERSION,
  developerPrompt,
  followupUserPrompt,
  reportUserPrompt,
  type UserSituation,
} from "./prompt";
import { FOLLOWUP_JSON_SCHEMA, FOLLOWUP_SCHEMA_VERSION, REPORT_JSON_SCHEMA, REPORT_SCHEMA_VERSION, type ReportContent } from "./schema";
import { VALIDATOR_VERSION, allText, validateFollowup, validateReport, type ValidationContext } from "./validate";

/** 一次生成任务里最多两次模型调用：首次 + 校验失败后重试一次（PRD §7） */
const CALLS_PER_RUN = 2;
const FOLLOWUP_CALLS = 2;

function situation(basis: OrderBasis, intent: OrderIntent): UserSituation {
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
    if (updated.length && refundNow) {
      await enqueue(tx, "refund_order", { orderId, reason }, { dedupeKey: `refund:${orderId}` });
    }
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

  const cast = basisCast(basis);
  const s = situation(basis, intent);
  const ctx = validationContext(basis.passages, s);
  const llm = getLlm();
  const started = Date.now();
  let feedback: string[] = [];

  for (let call = 1; call <= CALLS_PER_RUN; call++) {
    if (!(await reserveCall(orderId))) {
      await failOrder(orderId, "call_limit_reached", false);
      return "failed";
    }
    const res = await llm.generateStructured({
      route: "report",
      developer: developerPrompt(basis.topicId),
      user: reportUserPrompt({ castSummary: castSummary(cast), passages: basis.passages, situation: s, feedback }),
      schemaName: "wenshan_report_v1",
      jsonSchema: REPORT_JSON_SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: 6000,
      safetyIdentifier: safetyIdentifier(order.userId),
      fakeResponse: () => fakeReport(basis.passages, s),
    });
    const usage = { kind: "report" as const, orderId, readingId: order.readingId, promptVersion: PROMPT_VERSION, contentVersion: contentVersion(basis) };

    if (res.kind === "refusal") {
      await recordUsage({ ...usage, result: res });
      // 拒答按分流升级处理：不交付，立即退款（技术方案 5.7）
      await failOrder(orderId, "model_refusal", true);
      return "failed";
    }
    if (res.kind === "incomplete") {
      await recordUsage({ ...usage, result: res });
      feedback = [`输出不完整（${res.reason}），请控制篇幅并输出完整 JSON`];
      continue;
    }
    const checked = validateReport(res.data, ctx);
    let issues = checked.ok ? [] : checked.issues.map((i) => i.message);
    if (checked.ok) {
      const moderation = await llm.moderate([allText(checked.content)]);
      if (moderation.flagged) issues = [`内容审核未通过：${moderation.categories.join(", ")}`];
    }
    await recordUsage({ ...usage, result: res, issues });
    if (checked.ok && issues.length === 0) {
      return deliver(order.id, order.userId, order.readingId, basis, checked.content, {
        model: res.model,
        reasoningEffort: res.effort,
        attempts: order.generationCalls + call,
        latencyMs: Date.now() - started,
      });
    }
    feedback = issues;
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
      .where(and(eq(orders.id, orderId), eq(orders.status, "generating")))
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

async function releaseFollowup(followupId: string, orderId: string, status: "rejected" | "failed", answer?: unknown): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx
      .update(followups)
      .set({ status, answerCt: answer ? encryptJson(answer) : null, updatedAt: new Date() })
      .where(eq(followups.id, followupId));
    // 不是同一件事或生成失败时退还这次追问次数（技术方案 5.8）
    await tx
      .update(orders)
      .set({ followupsUsed: sql`greatest(${orders.followupsUsed} - 1, 0)`, updatedAt: new Date() })
      .where(eq(orders.id, orderId));
  });
}

export async function generateFollowup(followupId: string): Promise<void> {
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

  const cast = basisCast(basis);
  const s = situation(basis, intent);
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

  const llm = getLlm();
  let feedback: string[] = [];
  for (let call = 1; call <= FOLLOWUP_CALLS; call++) {
    const res = await llm.generateStructured({
      route: "followup",
      developer: developerPrompt(basis.topicId) + FOLLOWUP_DEVELOPER_SUFFIX,
      user: followupUserPrompt({
        castSummary: castSummary(cast),
        passages: basis.passages,
        situation: s,
        report: decryptJson<ReportContent>(report.contentCt),
        previous,
        question,
        feedback,
      }),
      schemaName: "wenshan_followup_v1",
      jsonSchema: FOLLOWUP_JSON_SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: 3000,
      safetyIdentifier: safetyIdentifier(order.userId),
      fakeResponse: () => fakeFollowup(question),
    });
    const usage = { kind: "followup" as const, orderId: f.orderId, readingId: order.readingId, promptVersion: PROMPT_VERSION, contentVersion: contentVersion(basis) };
    if (res.kind === "refusal") {
      await recordUsage({ ...usage, result: res });
      return releaseFollowup(f.id, f.orderId, "failed");
    }
    if (res.kind === "incomplete") {
      await recordUsage({ ...usage, result: res });
      feedback = ["输出不完整，请缩短回答并输出完整 JSON"];
      continue;
    }
    const checked = validateFollowup(res.data, ctx);
    let issues = checked.ok ? [] : checked.issues.map((i) => i.message);
    if (checked.ok) {
      const moderation = await llm.moderate([allText(checked.content)]);
      if (moderation.flagged) issues = [`内容审核未通过：${moderation.categories.join(", ")}`];
    }
    await recordUsage({ ...usage, result: res, issues });
    if (checked.ok && issues.length === 0) {
      if (!checked.content.is_same_matter) return releaseFollowup(f.id, f.orderId, "rejected", checked.content);
      const content = checked.content;
      // 写回答前确认订单仍是已交付（期间退款或拒付则丢弃）
      await db.transaction(async (tx) => {
        const [o] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, f.orderId)).for("update").limit(1);
        if (o?.status !== "delivered") {
          await tx.update(followups).set({ status: "failed", updatedAt: new Date() }).where(eq(followups.id, f.id));
          return;
        }
        await tx
          .update(followups)
          .set({
            status: "done",
            answerCt: encryptJson(content),
            versions: { prompt: PROMPT_VERSION, schema: FOLLOWUP_SCHEMA_VERSION, validator: VALIDATOR_VERSION, model: res.model, effort: res.effort },
            updatedAt: new Date(),
          })
          .where(eq(followups.id, f.id));
      });
      return;
    }
    feedback = issues;
  }
  await releaseFollowup(f.id, f.orderId, "failed");
}

export async function onFollowupJobExhausted(followupId: string): Promise<void> {
  const db = await getDb();
  const [f] = await db.select().from(followups).where(eq(followups.id, followupId)).limit(1);
  if (f && f.status === "queued") await releaseFollowup(f.id, f.orderId, "failed");
}
