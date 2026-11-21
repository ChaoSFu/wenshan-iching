import { and, gte, lt, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { generationAttempts, orders } from "../db/schema";
import type { StructuredResult, TransportFailure } from "./index";

/**
 * 模型用量与成本（技术方案第 11 节）。每一次模型调用都记一行，包括未购买用户的分流、
 * 校验失败后的重试；成本按调用时的价格表计算，推理 token 已包含在输出 token 内，不重复计费。
 */

/** 每百万 token 的美元价格（OpenAI 定价页 Standard 档，2026-11）：输入 / 缓存输入 / 输出 */
export const PRICES: Record<string, { input: number; cachedInput: number; output: number }> = {
  "gpt-6.2-astra": { input: 8, cachedInput: 0.4, output: 40 },
  "gpt-6.2-sol": { input: 2, cachedInput: 0.1, output: 10 },
  "gpt-6.1-terra": { input: 1, cachedInput: 0.05, output: 5 },
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, output: 0.5 },
};

/** 返回的模型名可能带日期后缀（如 gpt-6.2-sol-2026-10-01），按前缀匹配价格 */
export function priceFor(model: string) {
  const key = Object.keys(PRICES)
    .sort((a, b) => b.length - a.length)
    .find((k) => model === k || model.startsWith(`${k}-`));
  return key ? PRICES[key]! : null;
}

export interface TokenCounts {
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
}

/**
 * 单次调用的美元成本。价格表里没有这个模型、或者没有拿到用量（本地替身、请求失败）时返回 null：
 * 成本未知就如实显示"未知"，不按 0 计入。
 */
export function costUsd(model: string, t: TokenCounts): number | null {
  const p = priceFor(model);
  if (!p || t.inputTokens === null) return null;
  const cached = Math.min(t.cachedTokens ?? 0, t.inputTokens);
  const uncached = t.inputTokens - cached;
  return (uncached * p.input + cached * p.cachedInput + (t.outputTokens ?? 0) * p.output) / 1_000_000;
}

export interface UsageContext {
  kind: "triage" | "report" | "followup";
  orderId?: string | null;
  readingId?: string | null;
  promptVersion: string;
  contentVersion: string;
}

/**
 * 记一次业务调用。issues 是业务校验的问题；moderationCategories 非空表示结构与校验都通过、
 * 但输出内容审核没通过（单独记为 moderation_flagged，不混进校验失败）。
 * 这次调用之前失败的发送（网络、429、5xx）另记为 attempt_kind = transport。
 */
export async function recordUsage(
  input: UsageContext & {
    result: StructuredResult;
    issues?: string[] | null;
    moderationCategories?: string[] | null;
    failureReason?: string | null;
  },
): Promise<void> {
  const r = input.result;
  if (r.transportFailures?.length) await recordTransportFailures(input, r.model, r.effort, r.transportFailures);
  const db = await getDb();
  const moderated = Boolean(input.moderationCategories?.length);
  await db.insert(generationAttempts).values({
    orderId: input.orderId ?? null,
    readingId: input.readingId ?? null,
    kind: input.kind,
    model: r.model,
    effort: r.effort,
    promptVersion: input.promptVersion,
    contentVersion: input.contentVersion,
    inputTokens: r.usage.inputTokens,
    cachedTokens: r.usage.cachedTokens,
    outputTokens: r.usage.outputTokens,
    reasoningTokens: r.usage.reasoningTokens,
    latencyMs: r.latencyMs,
    status: r.kind === "ok" ? (moderated ? "moderation_flagged" : input.issues?.length ? "invalid" : "ok") : r.kind,
    refused: r.kind === "refusal",
    validatorErrors: moderated ? input.moderationCategories : input.issues?.length ? input.issues : null,
    failureReason:
      input.failureReason ??
      (r.kind === "incomplete" ? r.reason : r.kind === "refusal" ? "refusal" : moderated ? "moderation" : input.issues?.length ? "validation" : null),
  });
}

/** 失败的发送：没有用量，成本未知；业务调用最终也失败时（全部发送都失败）同样记在这里 */
export async function recordTransportFailures(ctx: UsageContext, model: string, effort: string, failures: TransportFailure[]): Promise<void> {
  if (!failures.length) return;
  const db = await getDb();
  await db.insert(generationAttempts).values(
    failures.map((f) => ({
      orderId: ctx.orderId ?? null,
      readingId: ctx.readingId ?? null,
      kind: ctx.kind,
      model,
      effort,
      attemptKind: "transport",
      promptVersion: ctx.promptVersion,
      contentVersion: ctx.contentVersion,
      latencyMs: f.latencyMs,
      status: "request_error",
      failureReason: `request_error:${f.error}`,
    })),
  );
}

export interface CostSummary {
  from: string;
  to: string;
  /** 业务调用次数（不含传输层重发） */
  calls: number;
  /** 传输层失败的发送次数（网络、429、5xx） */
  transportFailures: number;
  /** 已知成本之和 */
  totalUsd: number;
  /** 成本未知的业务调用（价格表里没有该模型或没有用量），不计入 totalUsd */
  unknownCostCalls: number;
  deliveredOrders: number;
  /** 期间全部模型成本（含未购买用户的分流、失败重试）÷ 成功交付的订单数 */
  costPerDeliveryUsd: number | null;
  byKind: Record<
    string,
    { calls: number; usd: number; unknownCostCalls: number; inputTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number; avgLatencyMs: number }
  >;
  byModel: Record<string, { calls: number; usd: number; unknownCostCalls: number }>;
  failures: Record<string, number>;
}

export async function costSummary(from: Date, to: Date): Promise<CostSummary> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(generationAttempts)
    .where(and(gte(generationAttempts.createdAt, from), lt(generationAttempts.createdAt, to)));
  const [delivered] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(gte(orders.deliveredAt, from), lt(orders.deliveredAt, to)));

  const summary: CostSummary = {
    from: from.toISOString(),
    to: to.toISOString(),
    calls: 0,
    transportFailures: 0,
    totalUsd: 0,
    unknownCostCalls: 0,
    deliveredOrders: delivered?.n ?? 0,
    costPerDeliveryUsd: null,
    byKind: {},
    byModel: {},
    failures: {},
  };
  for (const r of rows) {
    if (r.failureReason) summary.failures[r.failureReason] = (summary.failures[r.failureReason] ?? 0) + 1;
    if (r.attemptKind === "transport") {
      summary.transportFailures++;
      continue;
    }
    summary.calls++;
    const usd = costUsd(r.model, r);
    if (usd === null) summary.unknownCostCalls++;
    else summary.totalUsd += usd;
    const k = (summary.byKind[r.kind] ??= { calls: 0, usd: 0, unknownCostCalls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, avgLatencyMs: 0 });
    k.avgLatencyMs = (k.avgLatencyMs * k.calls + (r.latencyMs ?? 0)) / (k.calls + 1);
    k.calls++;
    if (usd === null) k.unknownCostCalls++;
    else k.usd += usd;
    k.inputTokens += r.inputTokens ?? 0;
    k.cachedTokens += r.cachedTokens ?? 0;
    k.outputTokens += r.outputTokens ?? 0;
    k.reasoningTokens += r.reasoningTokens ?? 0;
    const m = (summary.byModel[r.model] ??= { calls: 0, usd: 0, unknownCostCalls: 0 });
    m.calls++;
    if (usd === null) m.unknownCostCalls++;
    else m.usd += usd;
  }
  summary.costPerDeliveryUsd = summary.deliveredOrders ? summary.totalUsd / summary.deliveredOrders : null;
  return summary;
}
