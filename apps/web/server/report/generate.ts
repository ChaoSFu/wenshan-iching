import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { TopicId } from "@wenshan/content";
import { corpus, reportRules } from "../content";
import { decrypt, decryptJson, encrypt, encryptJson, safetyIdentifier } from "../crypto";
import { getDb } from "../db/client";
import { followups, generationAttempts, orders, readings, reports, triageResults } from "../db/schema";
import { env } from "../env";
import { enqueue } from "../jobs/queue";
import { getLlm, type StructuredResult } from "../llm";
import { toPlain, type ReadingPlain } from "../readings";
import { TRIAGE_VERSION } from "../triage";
import { fakeFollowup, fakeReport } from "./fake";
import { allowedPassages, castSummary, type AllowedPassage } from "./passages";
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

/** 一份报告最多调用两次模型：首次 + 校验失败后重试一次（PRD §7） */
const MAX_MODEL_CALLS = 2;

async function recordAttempt(orderId: string, kind: string, res: StructuredResult, issues: string[] | null): Promise<void> {
  const db = await getDb();
  await db.insert(generationAttempts).values({
    orderId,
    kind,
    model: res.model,
    inputTokens: res.usage.inputTokens,
    cachedTokens: res.usage.cachedTokens,
    outputTokens: res.usage.outputTokens,
    reasoningTokens: res.usage.reasoningTokens,
    latencyMs: res.latencyMs,
    status: res.kind === "ok" ? (issues?.length ? "invalid" : "ok") : res.kind,
    refused: res.kind === "refusal",
    validatorErrors: issues,
  });
}

async function situationFor(reading: ReadingPlain): Promise<UserSituation> {
  const db = await getDb();
  const [t] = await db
    .select()
    .from(triageResults)
    .where(eq(triageResults.readingId, reading.id))
    .orderBy(desc(triageResults.createdAt))
    .limit(1);
  const out = t?.outputCt ? decryptJson<{ question_summary?: string; missing_info?: string[] }>(t.outputCt) : null;
  return {
    topicId: reading.topicId,
    question: reading.question,
    context: reading.context,
    summary: out?.question_summary ?? null,
    missingInfo: out?.missing_info ?? [],
  };
}

function validationContext(passages: AllowedPassage[], s: UserSituation): ValidationContext {
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

/** 任务 generate_report：一次结构化生成 → 校验 →（失败重试一次）→ 入库并交付 */
export async function generateReport(orderId: string): Promise<void> {
  const db = await getDb();
  const [order] = await db
    .update(orders)
    .set({ status: "generating", updatedAt: new Date() })
    .where(and(eq(orders.id, orderId), inArray(orders.status, ["paid", "generating", "generation_failed"])))
    .returning();
  if (!order) return; // 已交付、已退款等，无需生成

  const [row] = await db.select().from(readings).where(eq(readings.id, order.readingId)).limit(1);
  if (!row?.questionCt) return failOrder(orderId, "reading_deleted", true);
  const reading = toPlain(row);
  const { passages, missing } = allowedPassages(reading.cast);
  if (missing.length) return failOrder(orderId, `missing_corpus:${missing.join(",")}`, true);

  const situation = await situationFor(reading);
  const ctx = validationContext(passages, situation);
  const llm = getLlm();
  const started = Date.now();
  let feedback: string[] = [];

  for (let call = 1; call <= MAX_MODEL_CALLS; call++) {
    const res = await llm.generateStructured({
      route: "report",
      developer: developerPrompt(reading.topicId),
      user: reportUserPrompt({ castSummary: castSummary(reading.cast), passages, situation, feedback }),
      schemaName: "wenshan_report_v1",
      jsonSchema: REPORT_JSON_SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: 6000,
      safetyIdentifier: safetyIdentifier(order.userId),
      fakeResponse: () => fakeReport(passages, situation),
    });

    if (res.kind === "refusal") {
      await recordAttempt(orderId, "report", res, null);
      // 拒答按分流升级处理：不交付，立即退款（技术方案 5.7）
      return failOrder(orderId, "model_refusal", true);
    }
    if (res.kind === "incomplete") {
      await recordAttempt(orderId, "report", res, [res.reason]);
      feedback = [`输出不完整（${res.reason}），请控制篇幅并输出完整 JSON`];
      continue;
    }
    const checked = validateReport(res.data, ctx);
    let issues = checked.ok ? [] : checked.issues.map((i) => i.message);
    if (checked.ok) {
      const moderation = await llm.moderate([allText(checked.content)]);
      if (moderation.flagged) issues = [`内容审核未通过：${moderation.categories.join(", ")}`];
    }
    await recordAttempt(orderId, "report", res, issues.length ? issues : null);
    if (checked.ok && issues.length === 0) {
      await deliver(orderId, order.userId, reading, checked.content, passages, {
        model: res.model,
        reasoningEffort: res.effort,
        attempts: call,
        latencyMs: Date.now() - started,
      });
      return;
    }
    feedback = issues;
  }
  await failOrder(orderId, "validation_failed", false);
}

async function deliver(
  orderId: string,
  userId: string,
  reading: ReadingPlain,
  content: ReportContent,
  passages: AllowedPassage[],
  meta: { model: string; reasoningEffort: string; attempts: number; latencyMs: number },
): Promise<void> {
  const db = await getDb();
  const rules = reportRules(reading.topicId);
  const cited = [...new Set(content.observations.flatMap((o) => o.citations))];
  const snapshot = passages.filter((p) => cited.includes(p.id)).map((p) => ({ id: p.id, title: p.title, text: p.text }));
  await db.transaction(async (tx) => {
    await tx.insert(reports).values({
      orderId,
      userId,
      readingId: reading.id,
      contentCt: encryptJson(content),
      citations: cited,
      citationsSnapshotCt: encryptJson(snapshot),
      versions: {
        topic: `${reading.topicId}@${rules.version}`,
        cast: reading.cast.ruleVersion,
        selection: "select@1",
        corpus: corpus.version,
        triage: TRIAGE_VERSION,
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
    await tx
      .update(orders)
      .set({ status: "delivered", deliveredAt: new Date(), failureReason: null, updatedAt: new Date() })
      .where(eq(orders.id, orderId));
    await enqueue(tx, "send_report_ready_email", { orderId }, { dedupeKey: `ready-mail:${orderId}` });
  });
}

/** 生成任务彻底失败（例如模型服务长时间不可用）：标为生成异常，等待后台重试或到期自动退款 */
export async function onReportJobExhausted(orderId: string): Promise<void> {
  await failOrder(orderId, "llm_unavailable", false);
}

const RETRY_EVERY_MS = 30 * 60_000;

/**
 * 生成异常的订单在退款期限前定期重新生成（PRD §8：后台自动重试，用户无需再付款）。
 * 拒答、原文缺失等不会自行好转的原因不重试，已直接退款。
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
  const [row] = order ? await db.select().from(readings).where(eq(readings.id, order.readingId)).limit(1) : [];
  if (!order || order.status !== "delivered" || !report?.contentCt || !row?.questionCt) {
    return releaseFollowup(f.id, f.orderId, "failed");
  }

  const reading = toPlain(row);
  const { passages } = allowedPassages(reading.cast);
  const situation = await situationFor(reading);
  const ctx = validationContext(passages, situation);
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
  for (let call = 1; call <= MAX_MODEL_CALLS; call++) {
    const res = await llm.generateStructured({
      route: "followup",
      developer: developerPrompt(reading.topicId as TopicId) + FOLLOWUP_DEVELOPER_SUFFIX,
      user: followupUserPrompt({
        castSummary: castSummary(reading.cast),
        passages,
        situation,
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
    if (res.kind === "refusal") {
      await recordAttempt(f.orderId, "followup", res, null);
      return releaseFollowup(f.id, f.orderId, "failed");
    }
    if (res.kind === "incomplete") {
      await recordAttempt(f.orderId, "followup", res, [res.reason]);
      feedback = ["输出不完整，请缩短回答并输出完整 JSON"];
      continue;
    }
    const checked = validateFollowup(res.data, ctx);
    let issues = checked.ok ? [] : checked.issues.map((i) => i.message);
    if (checked.ok) {
      const moderation = await llm.moderate([allText(checked.content)]);
      if (moderation.flagged) issues = [`内容审核未通过：${moderation.categories.join(", ")}`];
    }
    await recordAttempt(f.orderId, "followup", res, issues.length ? issues : null);
    if (checked.ok && issues.length === 0) {
      if (!checked.content.is_same_matter) return releaseFollowup(f.id, f.orderId, "rejected", checked.content);
      await db
        .update(followups)
        .set({
          status: "done",
          answerCt: encryptJson(checked.content),
          versions: { prompt: PROMPT_VERSION, schema: FOLLOWUP_SCHEMA_VERSION, validator: VALIDATOR_VERSION, model: res.model },
          updatedAt: new Date(),
        })
        .where(eq(followups.id, f.id));
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
