import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { TOPIC_IDS, type TopicId } from "@wenshan/content";
import { castFromTosses, tossesFromLines, type Cast, type LineValue } from "@wenshan/iching-core";
import { corpus } from "../content";
import { LlmTransientError, routeConfig, type Effort, type LlmProvider, type StructuredResult, type TransportFailure } from "../llm";
import { costUsd } from "../llm/usage";
import type { ReadingPlain } from "../readings";
import { FOLLOWUP_CALLS_PER_RUN, REPORT_CALLS_PER_RUN, attemptFollowup, attemptReport, type AttemptRun, type BusinessAttempt } from "../report/attempts";
import { situationOf, validationContext } from "../report/generate";
import type { AllowedPassage } from "../report/passages";
import type { FollowupContent, ReportContent } from "../report/schema";
import { allText, validateReport } from "../report/validate";
import { buildSnapshot, type OrderBasis, type OrderIntent } from "../snapshot";
import { TRIAGE_VERSION, decideTriage, type TriageOutput } from "../triage";

/**
 * 模型对照评测（第二轮 P1）。和线上走同一条路径：
 * 分流 decideTriage → 订单快照 buildSnapshot（同一套选文）→ attemptReport / attemptFollowup
 * （同一套业务校验、输出内容审核、带反馈重试）。不碰数据库。
 * 默认走本地替身；真实 API 只有显式传 --live 时才调用（scripts/eval-models.ts）。
 * 自动指标只做初筛，"引用是否支持解释、有没有编造背景、行动是否贴合"由人工评审表确认。
 */

const lineValue = z.union([z.literal(6), z.literal(7), z.literal(8), z.literal(9)]);
const caseSchema = z.object({
  id: z.string(),
  category: z.string(),
  topic: z.enum(TOPIC_IDS as [TopicId, ...TopicId[]]),
  question: z.string(),
  context: z.record(z.string(), z.string()).default({}),
  lines: z.array(lineValue).length(6),
  followup: z.string().optional(),
  expect: z.object({ decision: z.string().optional(), sameMatter: z.boolean().optional() }).default({}),
});
export type EvalCase = z.infer<typeof caseSchema>;

export function loadCases(file: string): EvalCase[] {
  const raw = parse(readFileSync(file, "utf8")) as { cases: unknown[] };
  return z.array(caseSchema).parse(raw.cases);
}

/** 一次业务运行的最终结果 */
export type RunOutcome =
  | "ok"
  | "invalid" // 两次都没过业务校验
  | "moderation_flagged" // 通过校验但输出内容审核没过
  | "refusal"
  | "incomplete"
  | "request_error" // 所有发送都失败（网络、429、5xx）
  | "content_missing" // 本卦必需原文缺失，线上同样不会生成
  | "not_run"; // 报告失败，追问不运行

export interface RunMetrics {
  caseId: string;
  category: string;
  topic: TopicId;
  route: "triage" | "report" | "followup";
  model: string;
  effort: string;
  outcome: RunOutcome;
  passed: boolean;
  /** 业务调用次数（含校验失败后的重试） */
  businessAttempts: number;
  /** 传输层失败的发送（网络、429、5xx），与业务重试分开 */
  transportFailures: number;
  /** 每次业务调用的结果，按顺序；失败类型从这里统计 */
  attemptOutcomes: string[];
  issueCodes: string[];
  /** 原文依据：每条观察都引用了本次主选文（不只是补充材料） */
  grounded: boolean | null;
  /** 输出里出现输入中没有的数字（事实准确性的初筛） */
  unsupportedNumbers: string[];
  /** 行动可执行：做什么具体、七天内的时间点、可观察的反馈 */
  actionExecutable: boolean | null;
  /** 与期望一致：分流决定 / 是否同一件事 */
  matchesExpectation: boolean | null;
  /** 端到端耗时：含重试、内容审核与退避等待 */
  e2eMs: number;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  /** 已知部分的成本；costKnown=false 时至少有一次调用的价格或用量未知 */
  costUsd: number;
  costKnown: boolean;
  /** 通过的报告或追问正文，供人工评审 */
  content?: ReportContent | FollowupContent;
  decision?: string;
}

const WITHIN_WEEK = /第\s*[1-7一二三四五六七]\s*天|[1-7一二三四五六七]\s*天内|本周|这周|周[一二三四五六日末]|七天|今天|明天/;

function numbersIn(text: string): string[] {
  return [...new Set(text.match(/\d+(?:\.\d+)?/g) ?? [])];
}

/** 输出正文（不含引用编号）中的数字必须能在输入里找到；1–7（第 N 天、N 次）除外 */
export function unsupportedNumbers(output: string, inputs: string[]): string[] {
  const allowed = new Set(inputs.flatMap(numbersIn));
  for (const n of ["1", "2", "3", "4", "5", "6", "7"]) allowed.add(n);
  return numbersIn(output).filter((n) => !allowed.has(n));
}

function actionExecutable(a: { what: string; by_when: string; feedback_signal: string } | null | undefined): boolean | null {
  if (!a) return null;
  return a.what.trim().length >= 10 && WITHIN_WEEK.test(a.by_when + a.what) && a.feedback_signal.trim().length >= 6;
}

function sumOrNull(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
}

/** 多次调用的 token 与成本合计；价格或用量未知的调用让 costKnown 为 false */
function usageOf(results: StructuredResult[]) {
  const costs = results.map((r) => costUsd(r.model, r.usage));
  return {
    inputTokens: sumOrNull(results.map((r) => r.usage.inputTokens)),
    cachedTokens: sumOrNull(results.map((r) => r.usage.cachedTokens)),
    outputTokens: sumOrNull(results.map((r) => r.usage.outputTokens)),
    reasoningTokens: sumOrNull(results.map((r) => r.usage.reasoningTokens)),
    costUsd: costs.reduce<number>((s, c) => s + (c ?? 0), 0),
    costKnown: results.length > 0 && costs.every((c) => c !== null),
  };
}

const NO_USAGE = { inputTokens: null, cachedTokens: null, outputTokens: null, reasoningTokens: null, costUsd: 0, costKnown: false };

function fromAttempts<T>(
  c: Pick<EvalCase, "id" | "category" | "topic">,
  route: "report" | "followup",
  model: { model: string; effort: string },
  run: AttemptRun<T> | { status: "request_error"; failures: TransportFailure[]; attempts: BusinessAttempt[] },
  e2eMs: number,
): RunMetrics {
  const attempts = run.attempts;
  const transport = attempts.reduce((s, a) => s + (a.result.transportFailures?.length ?? 0), 0) + (run.status === "request_error" ? run.failures.length : 0);
  const last = attempts.at(-1);
  const outcome: RunOutcome =
    run.status === "ok"
      ? "ok"
      : run.status === "request_error"
        ? "request_error"
        : run.status === "refusal"
          ? "refusal"
          : ((last?.outcome as RunOutcome | undefined) ?? "invalid");
  return {
    caseId: c.id,
    category: c.category,
    topic: c.topic,
    route,
    model: last?.result.model ?? model.model,
    effort: last?.result.effort ?? model.effort,
    outcome,
    passed: run.status === "ok",
    businessAttempts: attempts.length,
    transportFailures: transport,
    attemptOutcomes: attempts.map((a) => a.outcome),
    issueCodes: attempts.flatMap((a) => a.issueCodes),
    grounded: null,
    unsupportedNumbers: [],
    actionExecutable: null,
    matchesExpectation: null,
    e2eMs,
    ...(attempts.length ? usageOf(attempts.map((a) => a.result)) : NO_USAGE),
  };
}

async function guarded<T>(fn: () => Promise<AttemptRun<T>>): Promise<AttemptRun<T> | { status: "request_error"; failures: TransportFailure[]; attempts: BusinessAttempt[] }> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof LlmTransientError) return { status: "request_error", failures: err.transportFailures, attempts: [] };
    throw err;
  }
}

/** 评测用的阅读：与线上上传后的阅读同构（不入库） */
function evalReading(c: Pick<EvalCase, "id" | "topic" | "question" | "context" | "lines">): ReadingPlain & { cast: Cast } {
  const cast = castFromTosses(tossesFromLines(c.lines as LineValue[]));
  return {
    id: `eval-${c.id}`,
    clientReadingId: `eval-${c.id}`,
    userId: "eval",
    topicId: c.topic,
    topicOriginal: c.topic,
    question: c.question,
    context: c.context,
    cast,
    corpusVersion: corpus.version,
    revision: 1,
    updatedAt: new Date(0),
  };
}

export interface EvalOptions {
  llm: LlmProvider;
  cases: EvalCase[];
  triageModel: string;
  reportModels: string[];
  followupModels: string[];
  effort: Effort;
  /** 只用已审核内容（与真实收款一致）；默认 false：与模拟流程一致，未审核内容也参与 */
  reviewedOnly?: boolean;
}

/** 可购买的分流决定（与 requirePurchasableTriage 一致） */
const PURCHASABLE = new Set(["proceed", "reframe_suggested"]);

export async function runEval(opts: EvalOptions): Promise<RunMetrics[]> {
  const out: RunMetrics[] = [];
  for (const c of opts.cases) {
    const reading = evalReading(c);

    // —— 付费前分流（与 runTriage 同一个决策函数）——
    const t0 = Date.now();
    let triage: TriageOutput | null = null;
    try {
      const d = await decideTriage(opts.llm, reading, "eval", { model: opts.triageModel, effort: opts.effort });
      triage = d.output;
      const results = d.result ? [d.result] : [];
      out.push({
        caseId: c.id,
        category: c.category,
        topic: c.topic,
        route: "triage",
        model: d.model,
        effort: d.result?.effort ?? "-",
        outcome: d.output ? "ok" : "incomplete",
        passed: Boolean(d.output),
        businessAttempts: results.length,
        transportFailures: d.result?.transportFailures?.length ?? 0,
        attemptOutcomes: results.map((r) => r.kind),
        issueCodes: [],
        grounded: null,
        unsupportedNumbers: [],
        actionExecutable: null,
        matchesExpectation: c.expect.decision && d.output ? d.output.decision === c.expect.decision : null,
        e2eMs: Date.now() - t0,
        decision: d.output?.decision,
        ...(results.length ? usageOf(results) : NO_USAGE),
      });
    } catch (err) {
      if (!(err instanceof LlmTransientError)) throw err;
      out.push({
        caseId: c.id, category: c.category, topic: c.topic, route: "triage", model: opts.triageModel, effort: opts.effort,
        outcome: "request_error", passed: false, businessAttempts: 0, transportFailures: err.transportFailures.length,
        attemptOutcomes: [], issueCodes: [], grounded: null, unsupportedNumbers: [], actionExecutable: null,
        matchesExpectation: null, e2eMs: Date.now() - t0, ...NO_USAGE,
      });
    }
    if (!triage || !PURCHASABLE.has(triage.decision)) continue; // 转介、需改写或分流失败：线上同样不会生成报告

    // —— 订单快照：与下单时同一套选文 ——
    const snapshot = buildSnapshot(reading, { id: null, version: TRIAGE_VERSION, output: triage }, { includeUnreviewed: !opts.reviewedOnly });
    const { basis, intent } = snapshot;
    const situation = situationOf(basis, intent);
    const cast = reading.cast;
    if (snapshot.missing.length) {
      for (const model of opts.reportModels) {
        out.push({ ...fromAttempts(c, "report", { model, effort: opts.effort }, { status: "exhausted", attempts: [] }, 0), outcome: "content_missing" });
      }
      continue;
    }
    const primaryIds = new Set(basis.passages.filter((p) => p.role !== "commentary").map((p) => p.id));
    const inputs = [c.question, ...Object.values(c.context), ...basis.passages.map((p: AllowedPassage) => p.text)];

    // —— 报告：每个模型各跑一次完整业务流程（含校验重试）——
    let baselineReport: ReportContent | null = null;
    for (const [i, model] of opts.reportModels.entries()) {
      const started = Date.now();
      const run = await guarded(() =>
        attemptReport({
          llm: opts.llm,
          topicId: basis.topicId,
          cast,
          passages: basis.passages,
          situation,
          ctx: validationContext(basis.passages, situation),
          safetyIdentifier: "eval",
          calls: REPORT_CALLS_PER_RUN,
          override: { model, effort: opts.effort },
          routeHint: routeConfig("report"),
        }),
      );
      const row = fromAttempts(c, "report", { model, effort: opts.effort }, run, Date.now() - started);
      if (run.status === "ok") {
        const content = run.content;
        if (i === 0) baselineReport = content;
        row.content = content;
        row.grounded = content.observations.every((o) => o.citations.some((id) => primaryIds.has(id)));
        row.unsupportedNumbers = unsupportedNumbers(allText({ ...content, observations: content.observations.map((o) => ({ angle: o.angle, text: o.text })) }), inputs);
        row.actionExecutable = actionExecutable(content.seven_day_action);
      }
      out.push(row);
    }

    // —— 同题追问：基于首个报告模型（线上配置）的报告；报告失败时标为未运行 ——
    if (c.followup) {
      for (const model of opts.followupModels) {
        if (!baselineReport) {
          out.push({ ...fromAttempts(c, "followup", { model, effort: opts.effort }, { status: "exhausted", attempts: [] }, 0), outcome: "not_run" });
          continue;
        }
        out.push(
          await runFollowup(opts, c, { basis, intent, cast, report: baselineReport, previous: [], question: c.followup, model, inputs }),
        );
      }
    }
  }
  return out;
}

async function runFollowup(
  opts: Pick<EvalOptions, "llm" | "effort">,
  c: Pick<EvalCase, "id" | "category" | "topic" | "expect">,
  x: {
    basis: OrderBasis;
    intent: OrderIntent;
    cast: Cast;
    report: ReportContent;
    previous: { question: string; answer: string }[];
    question: string;
    model: string;
    inputs: string[];
  },
): Promise<RunMetrics> {
  const situation = situationOf(x.basis, x.intent);
  const ctx = validationContext(x.basis.passages, situation);
  ctx.quotableSources.push(x.question);
  const started = Date.now();
  const run = await guarded(() =>
    attemptFollowup({
      llm: opts.llm,
      topicId: x.basis.topicId,
      cast: x.cast,
      passages: x.basis.passages,
      situation,
      ctx,
      safetyIdentifier: "eval",
      calls: FOLLOWUP_CALLS_PER_RUN,
      override: { model: x.model, effort: opts.effort },
      routeHint: routeConfig("followup"),
      report: x.report,
      previous: x.previous,
      question: x.question,
    }),
  );
  const row = fromAttempts(c, "followup", { model: x.model, effort: opts.effort }, run, Date.now() - started);
  if (run.status === "ok") {
    const content = run.content;
    row.content = content;
    row.unsupportedNumbers = unsupportedNumbers(allText({ ...content, citations: [] }), [...x.inputs, x.question, ...x.previous.flatMap((p) => [p.question, p.answer])]);
    row.actionExecutable = content.adjusted_action ? actionExecutable(content.adjusted_action) : null;
    row.matchesExpectation = c.expect.sameMatter !== undefined ? content.is_same_matter === c.expect.sameMatter : null;
  }
  return row;
}

// ---------- 追问盲测 ----------

const blindCaseSchema = z.object({
  id: z.string(),
  topic: z.enum(TOPIC_IDS as [TopicId, ...TopicId[]]),
  question: z.string(),
  context: z.record(z.string(), z.string()).default({}),
  lines: z.array(lineValue).length(6),
  summary: z.string(),
  history: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
  followups: z.array(z.object({ question: z.string(), sameMatter: z.boolean() })).min(1),
});
export type BlindCase = z.infer<typeof blindCaseSchema>;

export function loadBlindCases(file: string): BlindCase[] {
  const raw = parse(readFileSync(file, "utf8")) as { cases: unknown[] };
  return z.array(blindCaseSchema).parse(raw.cases);
}

export interface FrozenReport {
  caseId: string;
  /** 生成这份报告的模型（fake: 开头表示替身生成，只能用于验证流程） */
  model: string;
  frozenAt: string;
  report: ReportContent;
}

function blindBasis(c: BlindCase, reviewedOnly: boolean) {
  const reading = evalReading({ ...c });
  const triage: TriageOutput = {
    confirmed_topic: c.topic,
    question_summary: c.summary,
    controllable_reframe: null,
    missing_info: [],
    risk_category: "none",
    decision: "proceed",
    user_message: "",
  };
  const snap = buildSnapshot(reading, { id: null, version: TRIAGE_VERSION, output: triage }, { includeUnreviewed: !reviewedOnly });
  return { ...snap, cast: reading.cast };
}

/** 固定报告：为盲测用例生成一次报告并通过业务校验，之后所有模型的追问都基于这一份 */
export async function freezeBlindReports(opts: { llm: LlmProvider; cases: BlindCase[]; model: string; effort: Effort; reviewedOnly?: boolean }): Promise<FrozenReport[]> {
  const out: FrozenReport[] = [];
  for (const c of opts.cases) {
    const { basis, intent, cast } = blindBasis(c, Boolean(opts.reviewedOnly));
    const situation = situationOf(basis, intent);
    const run = await attemptReport({
      llm: opts.llm,
      topicId: basis.topicId,
      cast,
      passages: basis.passages,
      situation,
      ctx: validationContext(basis.passages, situation),
      safetyIdentifier: "eval",
      calls: REPORT_CALLS_PER_RUN,
      override: { model: opts.model, effort: opts.effort },
      routeHint: routeConfig("report"),
    });
    if (run.status !== "ok") throw new Error(`blind case ${c.id}: report did not pass validation (${run.status}); fix the case or retry`);
    out.push({ caseId: c.id, model: run.result.model, frozenAt: new Date().toISOString(), report: run.content });
  }
  return out;
}

export interface BlindItem {
  caseId: string;
  followup: string;
  /** 盲测标签 A/B/…；与模型的对应关系只在 key 里 */
  label: string;
  row: RunMetrics;
}

/** 同一份固定报告、同一段历史，各模型回答同一组追问；标签顺序按用例随机打乱 */
export async function runBlindFollowups(opts: {
  llm: LlmProvider;
  cases: BlindCase[];
  frozen: FrozenReport[];
  models: string[];
  effort: Effort;
  reviewedOnly?: boolean;
  seed?: number;
}): Promise<{ items: BlindItem[]; key: Record<string, Record<string, string>>; caseNotes: Record<string, string> }> {
  // mulberry32：给定 seed 可复现（测试用），默认用随机 seed
  let seed = (opts.seed ?? randomInt(2 ** 31)) >>> 0;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const shuffle = <T,>(xs: T[]): T[] => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  };
  const items: BlindItem[] = [];
  const key: Record<string, Record<string, string>> = {};
  const caseNotes: Record<string, string> = {};
  for (const c of opts.cases) {
    const frozen = opts.frozen.find((f) => f.caseId === c.id);
    if (!frozen) throw new Error(`blind case ${c.id} has no frozen report; run with --freeze-reports first`);
    const { basis, intent, cast } = blindBasis(c, Boolean(opts.reviewedOnly));
    const situation = situationOf(basis, intent);
    // 固定报告本身也要通过当前的业务校验，否则对比没有意义
    const check = validateReport(frozen.report, validationContext(basis.passages, situation));
    if (!check.ok) throw new Error(`frozen report for ${c.id} no longer passes validation: ${check.issues.map((i) => i.code).join(", ")}`);
    const order = shuffle(opts.models);
    const labels = Object.fromEntries(order.map((m, i) => [m, String.fromCharCode(65 + i)]));
    key[c.id] = Object.fromEntries(order.map((m) => [labels[m]!, m]));
    // 评审时要看到两边共同依据的报告与历史
    const r = frozen.report;
    caseNotes[c.id] = [
      `**固定报告（各模型共用）**：${r.situation}`,
      ...r.observations.map((o) => `- 观察（${o.angle}）：${o.text}（引用 ${o.citations.join("、")}）`),
      `- 七天行动：${r.seven_day_action.what}（${r.seven_day_action.by_when}）`,
      "",
      c.history.length ? `**此前的追问**：\n${c.history.map((h) => `- 问：${h.question}\n  答：${h.answer}`).join("\n")}` : "**此前的追问**：无",
    ].join("\n");
    const inputs = [c.question, ...Object.values(c.context), ...basis.passages.map((p) => p.text)];
    for (const f of c.followups) {
      for (const model of order) {
        const row = await runFollowup(opts, { id: c.id, category: "blind_followup", topic: c.topic, expect: { sameMatter: f.sameMatter } }, {
          basis,
          intent,
          cast,
          report: frozen.report,
          previous: c.history,
          question: f.question,
          model,
          inputs,
        });
        items.push({ caseId: c.id, followup: f.question, label: labels[model]!, row });
      }
    }
  }
  return { items, key, caseNotes };
}

// ---------- 汇总 ----------

export interface ModelSummary {
  route: string;
  model: string;
  /** 样本数（不含未运行） */
  samples: number;
  notRun: number;
  passRate: number;
  /** 最终结果分布：ok / invalid / moderation_flagged / refusal / incomplete / request_error / content_missing */
  outcomes: Record<string, number>;
  /** 每次业务调用的失败类型（含被重试救回来的那次） */
  attemptFailures: Record<string, number>;
  /** 业务校验问题码出现次数 */
  issueCodes: Record<string, number>;
  businessAttempts: number;
  transportFailures: number;
  groundedRate: number | null;
  actionRate: number | null;
  unsupportedNumberRuns: number;
  expectationRate: number | null;
  e2eP50Ms: number;
  e2eP90Ms: number;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  /** 已知成本之和 */
  knownCostUsd: number;
  /** 成本未知的样本数（价格表缺该模型、或替身没有用量）——不按 0 计 */
  unknownCostRuns: number;
  /** 每个样本的平均成本；有未知成本时为 null */
  avgCostUsd: number | null;
}

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
}

export function summarize(rows: RunMetrics[]): ModelSummary[] {
  const groups = new Map<string, RunMetrics[]>();
  for (const r of rows) {
    if (r.model === "rules") continue;
    const k = `${r.route}|${r.model}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const rate = (xs: (boolean | null)[]) => {
    const v = xs.filter((x): x is boolean => x !== null);
    return v.length ? v.filter(Boolean).length / v.length : null;
  };
  const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
  return [...groups.entries()].map(([k, all]) => {
    const [route, model] = k.split("|") as [string, string];
    const rs = all.filter((r) => r.outcome !== "not_run");
    const unknown = rs.filter((r) => !r.costKnown).length;
    const known = rs.reduce((s, r) => s + r.costUsd, 0);
    const tok = (f: (r: RunMetrics) => number | null) => sumOrNull(rs.map(f));
    return {
      route,
      model,
      samples: rs.length,
      notRun: all.length - rs.length,
      passRate: rs.length ? rs.filter((r) => r.passed).length / rs.length : 0,
      outcomes: count(rs.map((r) => r.outcome)),
      attemptFailures: count(rs.flatMap((r) => r.attemptOutcomes.filter((o) => o !== "ok"))),
      issueCodes: count(rs.flatMap((r) => r.issueCodes)),
      businessAttempts: rs.reduce((s, r) => s + r.businessAttempts, 0),
      transportFailures: rs.reduce((s, r) => s + r.transportFailures, 0),
      groundedRate: rate(rs.map((r) => r.grounded)),
      actionRate: rate(rs.map((r) => r.actionExecutable)),
      unsupportedNumberRuns: rs.filter((r) => r.unsupportedNumbers.length > 0).length,
      expectationRate: rate(rs.map((r) => r.matchesExpectation)),
      e2eP50Ms: percentile(rs.map((r) => r.e2eMs), 0.5),
      e2eP90Ms: percentile(rs.map((r) => r.e2eMs), 0.9),
      inputTokens: tok((r) => r.inputTokens),
      cachedTokens: tok((r) => r.cachedTokens),
      outputTokens: tok((r) => r.outputTokens),
      reasoningTokens: tok((r) => r.reasoningTokens),
      knownCostUsd: known,
      unknownCostRuns: unknown,
      avgCostUsd: rs.length && unknown === 0 ? known / rs.length : null,
    };
  });
}

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const usd = (x: number) => `$${x.toFixed(4)}`;
const kv = (m: Record<string, number>) =>
  Object.entries(m)
    .map(([k, v]) => `${k} ${v}`)
    .join("，") || "—";

export function toMarkdown(summary: ModelSummary[], meta: { live: boolean; date: string; cases: number; title?: string }): string {
  const cost = (s: ModelSummary) =>
    s.unknownCostRuns === s.samples ? "未知" : s.unknownCostRuns ? `${usd(s.knownCostUsd)} + ${s.unknownCostRuns} 个未知` : usd(s.knownCostUsd);
  const lines = [
    `# ${meta.title ?? "模型对照评测"} ${meta.date}（${meta.live ? "真实 API" : "本地替身"}，${meta.cases} 个用例）`,
    "",
    "| 环节 | 模型 | 样本 | 未运行 | 通过率 | 原文依据 | 行动可执行 | 含无依据数字 | 符合期望 | 业务调用 | 传输重发 | P50 | P90 | 输入/缓存/输出(推理) token | 平均成本 | 合计成本 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...summary.map(
      (s) =>
        `| ${s.route} | ${s.model} | ${s.samples} | ${s.notRun} | ${pct(s.passRate)} | ${pct(s.groundedRate)} | ${pct(s.actionRate)} | ${s.unsupportedNumberRuns} | ${pct(s.expectationRate)} | ${s.businessAttempts} | ${s.transportFailures} | ${s.e2eP50Ms} ms | ${s.e2eP90Ms} ms | ${
          s.inputTokens === null ? "未知" : `${s.inputTokens}/${s.cachedTokens ?? 0}/${s.outputTokens ?? 0}(${s.reasoningTokens ?? 0})`
        } | ${s.avgCostUsd === null ? "未知" : usd(s.avgCostUsd)} | ${cost(s)} |`,
    ),
    "",
    "## 失败类型",
    "",
    "| 环节 | 模型 | 最终结果 | 各次业务调用的失败 | 校验问题码 |",
    "|---|---|---|---|---|",
    ...summary.map((s) => `| ${s.route} | ${s.model} | ${kv(s.outcomes)} | ${kv(s.attemptFailures)} | ${kv(s.issueCodes)} |`),
    "",
    "- 业务调用：一次完整的生成请求，校验失败后带反馈重试也算一次；传输重发：同一次业务调用里网络、429、5xx 导致的重发，不计入业务调用。",
    "- moderation_flagged：结构与业务校验都通过、但输出内容审核未通过；request_error：所有发送都失败；not_run：报告没有通过，追问不运行。",
    "- 端到端耗时含重试、输出内容审核与退避等待。成本按 server/llm/usage.ts 的价格表计算，推理 token 已含在输出 token 内；价格表缺该模型或没有用量时显示\"未知\"，不按 0 计。",
    meta.live ? "" : "- 本地替身不产生 token，成本为未知；只验证评测流程本身，不代表模型质量。",
  ];
  return lines.join("\n");
}

/** 人工评审表：自动指标只是初筛，三项必须人工确认 */
export function reviewSheet(
  rows: RunMetrics[],
  cases: { id: string; question: string; context: Record<string, string> }[],
  opts: { blindLabels?: Map<RunMetrics, string>; caseNotes?: Record<string, string> } = {},
): string {
  const lines = [
    "# 人工评审表",
    "",
    "每条请逐项勾选：",
    "- 引用的原文确实支持这条解释（不是牵强附会，不是只引了补充材料）",
    "- 没有编造用户没有给出的背景、人物、数字或经历",
    "- 七天行动贴合用户的处境与约束，具体可做、能看到反馈",
    "",
  ];
  const noted = new Set<string>();
  for (const r of rows) {
    if (!r.content) continue;
    const c = cases.find((x) => x.id === r.caseId);
    const who = opts.blindLabels?.get(r) ?? r.model;
    const note = opts.caseNotes?.[r.caseId];
    if (note && !noted.has(r.caseId)) {
      noted.add(r.caseId);
      lines.push(`# 用例 ${r.caseId}`, "", note, "");
    }
    lines.push(`## ${r.caseId} · ${r.route} · ${who}`, "");
    if (c) lines.push(`**问题**：${c.question}`, "", `**背景**：${Object.entries(c.context).map(([k, v]) => `${k}=${v}`).join("；") || "（无）"}`, "");
    if (r.route === "report") {
      const rc = r.content as ReportContent;
      lines.push(`**处境**：${rc.situation}`, "");
      for (const o of rc.observations) {
        lines.push(`- 观察（${o.angle}）：${o.text}`);
        for (const id of o.citations) lines.push(`  - 引用 ${id}：「${corpus.entries[id]?.text ?? "（不在内容包中）"}」`);
      }
      lines.push("", `**七天行动**：${rc.seven_day_action.what}（${rc.seven_day_action.by_when}；反馈：${rc.seven_day_action.feedback_signal}）`, "");
    } else {
      const fc = r.content as FollowupContent;
      lines.push(`**同一件事**：${fc.is_same_matter ? "是" : "否"}`, "", `**回答**：${fc.answer}`, "");
      for (const id of fc.citations) lines.push(`- 引用 ${id}：「${corpus.entries[id]?.text ?? "（不在内容包中）"}」`);
      if (fc.adjusted_action) lines.push(`**调整后的行动**：${fc.adjusted_action.what}（${fc.adjusted_action.by_when}）`);
      lines.push("");
    }
    if (r.unsupportedNumbers.length) lines.push(`> 自动初筛：出现输入里没有的数字 ${r.unsupportedNumbers.join("、")}`, "");
    lines.push("- [ ] 引用支持解释", "- [ ] 没有编造背景", "- [ ] 行动贴合处境", "- 备注：", "");
  }
  return lines.join("\n");
}
