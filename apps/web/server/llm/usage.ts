import { and, gte, lt, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { generationAttempts, orders } from "../db/schema";
import type { StructuredResult } from "./index";

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

/** 单次调用的美元成本；未知模型或没有用量（如本地替身）返回 0 */
export function costUsd(model: string, t: TokenCounts): number {
  const p = priceFor(model);
  if (!p || t.inputTokens === null) return 0;
  const cached = Math.min(t.cachedTokens ?? 0, t.inputTokens);
  const uncached = t.inputTokens - cached;
  return (uncached * p.input + cached * p.cachedInput + (t.outputTokens ?? 0) * p.output) / 1_000_000;
}

export async function recordUsage(input: {
  kind: "triage" | "report" | "followup";
  orderId?: string | null;
  readingId?: string | null;
  result: StructuredResult;
  promptVersion: string;
  contentVersion: string;
  issues?: string[] | null;
  failureReason?: string | null;
}): Promise<void> {
  const db = await getDb();
  const r = input.result;
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
    status: r.kind === "ok" ? (input.issues?.length ? "invalid" : "ok") : r.kind,
    refused: r.kind === "refusal",
    validatorErrors: input.issues?.length ? input.issues : null,
    failureReason: input.failureReason ?? (r.kind === "incomplete" ? r.reason : r.kind === "refusal" ? "refusal" : input.issues?.length ? "validation" : null),
  });
}

export interface CostSummary {
  from: string;
  to: string;
  calls: number;
  totalUsd: number;
  deliveredOrders: number;
  /** 期间全部模型成本（含未购买用户的分流、失败重试）÷ 成功交付的订单数 */
  costPerDeliveryUsd: number | null;
  byKind: Record<string, { calls: number; usd: number; inputTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number; avgLatencyMs: number }>;
  byModel: Record<string, { calls: number; usd: number }>;
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
    calls: rows.length,
    totalUsd: 0,
    deliveredOrders: delivered?.n ?? 0,
    costPerDeliveryUsd: null,
    byKind: {},
    byModel: {},
    failures: {},
  };
  for (const r of rows) {
    const usd = costUsd(r.model, r);
    summary.totalUsd += usd;
    const k = (summary.byKind[r.kind] ??= { calls: 0, usd: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, avgLatencyMs: 0 });
    k.avgLatencyMs = (k.avgLatencyMs * k.calls + (r.latencyMs ?? 0)) / (k.calls + 1);
    k.calls++;
    k.usd += usd;
    k.inputTokens += r.inputTokens ?? 0;
    k.cachedTokens += r.cachedTokens ?? 0;
    k.outputTokens += r.outputTokens ?? 0;
    k.reasoningTokens += r.reasoningTokens ?? 0;
    const m = (summary.byModel[r.model] ??= { calls: 0, usd: 0 });
    m.calls++;
    m.usd += usd;
    if (r.failureReason) summary.failures[r.failureReason] = (summary.failures[r.failureReason] ?? 0) + 1;
  }
  summary.costPerDeliveryUsd = summary.deliveredOrders ? summary.totalUsd / summary.deliveredOrders : null;
  return summary;
}
