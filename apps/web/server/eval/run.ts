import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { TOPIC_IDS, runLocalTriage, type TopicId } from "@wenshan/content";
import { castFromTosses, tossesFromLines, type LineValue } from "@wenshan/iching-core";
import { topicsBundle } from "../content";
import type { Effort, LlmProvider, StructuredResult } from "../llm";
import { costUsd } from "../llm/usage";
import { validationContext } from "../report/generate";
import { allowedPassages, castSummary, type AllowedPassage } from "../report/passages";
import { FOLLOWUP_DEVELOPER_SUFFIX, developerPrompt, followupUserPrompt, reportUserPrompt, type UserSituation } from "../report/prompt";
import { fakeFollowup, fakeReport } from "../report/fake";
import { FOLLOWUP_JSON_SCHEMA, REPORT_JSON_SCHEMA, type ReportContent } from "../report/schema";
import { allText, validateFollowup, validateReport } from "../report/validate";
import { buildTriageRequest, enforceRules, type TriageOutput } from "../triage";

/**
 * 模型对照评测：固定输入，比较原文依据、事实准确性、行动可执行性、通过率、耗时和成本。
 * 默认走本地替身；真实 API 只有显式传 --live 时才调用（scripts/eval-models.ts）。
 * 新模型先过同一套评测，再通过配置切换。
 */

const caseSchema = z.object({
  id: z.string(),
  category: z.string(),
  topic: z.enum(TOPIC_IDS as [TopicId, ...TopicId[]]),
  question: z.string(),
  context: z.record(z.string(), z.string()).default({}),
  lines: z.array(z.union([z.literal(6), z.literal(7), z.literal(8), z.literal(9)])).length(6),
  followup: z.string().optional(),
  expect: z.object({ decision: z.string().optional(), sameMatter: z.boolean().optional() }).default({}),
});
export type EvalCase = z.infer<typeof caseSchema>;

export function loadCases(file: string): EvalCase[] {
  const raw = parse(readFileSync(file, "utf8")) as { cases: unknown[] };
  return z.array(caseSchema).parse(raw.cases);
}

export interface RunMetrics {
  caseId: string;
  category: string;
  route: "triage" | "report" | "followup";
  model: string;
  effort: string;
  kind: StructuredResult["kind"];
  /** 结构与校验器（引用、错引、禁用断言、内容审核前的规则）全部通过 */
  passed: boolean;
  issues: string[];
  /** 原文依据：每条观察都引用了本次选文（非仅补充材料） */
  grounded: boolean | null;
  /** 事实准确性（启发式）：输出里出现输入中没有的数字 */
  unsupportedNumbers: string[];
  /** 行动可执行：做什么具体、七天内的时间点、可观察的反馈 */
  actionExecutable: boolean | null;
  /** 与期望一致：分流决定 / 是否同一件事 */
  matchesExpectation: boolean | null;
  latencyMs: number;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  costUsd: number;
}

const WITHIN_WEEK = /第\s*[1-7一二三四五六七]\s*天|[1-7一二三四五六七]\s*天内|本周|这周|周[一二三四五六日末]|七天|今天|明天/;

function numbersIn(text: string): string[] {
  return [...new Set(text.match(/\d+(?:\.\d+)?/g) ?? [])];
}

/** 输出正文（不含引用编号）中的数字必须能在输入里找到；1–7（第 N 天、N 次）除外 */
export function unsupportedNumbers(output: string, inputs: string[]): string[] {
  const allowed = new Set(inputs.flatMap(numbersIn));
  for (const n of ["1", "2", "3", "4", "5", "6", "7"]) allowed.add(n); // 第 N 天、N 次等时间与次数
  return numbersIn(output).filter((n) => !allowed.has(n));
}

function actionExecutable(a: { what: string; by_when: string; feedback_signal: string } | null | undefined): boolean | null {
  if (!a) return null;
  return a.what.trim().length >= 10 && WITHIN_WEEK.test(a.by_when + a.what) && a.feedback_signal.trim().length >= 6;
}

function metricsBase(c: EvalCase, route: RunMetrics["route"], res: StructuredResult): Omit<RunMetrics, "passed" | "issues" | "grounded" | "unsupportedNumbers" | "actionExecutable" | "matchesExpectation"> {
  return {
    caseId: c.id,
    category: c.category,
    route,
    model: res.model,
    effort: res.effort,
    kind: res.kind,
    latencyMs: res.latencyMs,
    inputTokens: res.usage.inputTokens,
    cachedTokens: res.usage.cachedTokens,
    outputTokens: res.usage.outputTokens,
    costUsd: costUsd(res.model, res.usage),
  };
}

export interface EvalOptions {
  llm: LlmProvider;
  cases: EvalCase[];
  triageModel: string;
  reportModels: string[];
  followupModels: string[];
  effort: Effort;
}

export async function runEval(opts: EvalOptions): Promise<RunMetrics[]> {
  const out: RunMetrics[] = [];
  for (const c of opts.cases) {
    const cast = castFromTosses(tossesFromLines(c.lines as LineValue[]));
    const { passages } = allowedPassages(cast, { includeUnreviewed: true });
    const reading = { topicId: c.topic, question: c.question, context: c.context };

    // —— 付费前分流 ——
    const local = runLocalTriage([c.question, ...Object.values(c.context)].join("\n"), topicsBundle.triage).crisis;
    const moderation = await opts.llm.moderate([c.question, ...Object.values(c.context)]);
    const moderationCrisis = moderation.categories.some((x) => x.startsWith("self-harm") || x.startsWith("violence"));
    let decision: string;
    let summary: string | null = null;
    let missing: string[] = [];
    if (local || moderationCrisis) {
      decision = "crisis";
    } else {
      const req = { ...buildTriageRequest(reading, "eval"), override: { model: opts.triageModel, effort: opts.effort } };
      const res = await opts.llm.generateStructured(req);
      const enforced = res.kind === "ok" ? enforceRules(res.data as TriageOutput, { moderationCrisis, localCrisis: local }) : null;
      decision = enforced?.decision ?? (res.kind === "refusal" ? "block_paid" : "error");
      summary = enforced?.question_summary ?? null;
      missing = enforced?.missing_info ?? [];
      out.push({
        ...metricsBase(c, "triage", res),
        passed: res.kind === "ok",
        issues: res.kind === "ok" ? [] : [res.kind],
        grounded: null,
        unsupportedNumbers: [],
        actionExecutable: null,
        matchesExpectation: c.expect.decision ? decision === c.expect.decision : null,
      });
    }
    if (decision !== "proceed" && decision !== "reframe_suggested") {
      if (decision === "crisis") {
        out.push({
          caseId: c.id, category: c.category, route: "triage", model: "rules", effort: "-", kind: "ok", passed: true, issues: [],
          grounded: null, unsupportedNumbers: [], actionExecutable: null,
          matchesExpectation: c.expect.decision ? c.expect.decision === "crisis" : null,
          latencyMs: 0, inputTokens: null, cachedTokens: null, outputTokens: null, costUsd: 0,
        });
      }
      continue; // 转介或需改写：不生成报告
    }

    // —— 报告 ——
    const situation: UserSituation = { topicId: c.topic, question: c.question, context: c.context, summary, missingInfo: missing };
    const ctx = validationContext(passages, situation);
    const primaryIds = new Set(passages.filter((p) => p.role !== "commentary").map((p) => p.id));
    const inputs = [c.question, ...Object.values(c.context), ...passages.map((p: AllowedPassage) => p.text)];
    let firstReport: ReportContent | null = null;
    for (const model of opts.reportModels) {
      const res = await opts.llm.generateStructured({
        route: "report",
        override: { model, effort: opts.effort },
        developer: developerPrompt(c.topic),
        user: reportUserPrompt({ castSummary: castSummary(cast), passages, situation }),
        schemaName: "wenshan_report_v1",
        jsonSchema: REPORT_JSON_SCHEMA as unknown as Record<string, unknown>,
        maxOutputTokens: 6000,
        safetyIdentifier: "eval",
        fakeResponse: () => fakeReport(passages, situation),
      });
      const checked = res.kind === "ok" ? validateReport(res.data, ctx) : null;
      const content = checked?.ok ? checked.content : null;
      firstReport ??= content;
      out.push({
        ...metricsBase(c, "report", res),
        passed: Boolean(checked?.ok),
        issues: checked && !checked.ok ? checked.issues.map((i) => i.code) : res.kind === "ok" ? [] : [res.kind],
        grounded: content ? content.observations.every((o) => o.citations.some((id) => primaryIds.has(id))) : null,
        unsupportedNumbers: content ? unsupportedNumbers(allText({ ...content, observations: content.observations.map((o) => ({ angle: o.angle, text: o.text })) }), inputs) : [],
        actionExecutable: content ? actionExecutable(content.seven_day_action) : null,
        matchesExpectation: null,
      });
    }

    // —— 同题追问 ——
    if (c.followup) {
      const report = firstReport ?? fakeReport(passages, situation);
      const fctx = validationContext(passages, situation);
      fctx.quotableSources.push(c.followup);
      for (const model of opts.followupModels) {
        const res = await opts.llm.generateStructured({
          route: "followup",
          override: { model, effort: opts.effort },
          developer: developerPrompt(c.topic) + FOLLOWUP_DEVELOPER_SUFFIX,
          user: followupUserPrompt({ castSummary: castSummary(cast), passages, situation, report, previous: [], question: c.followup }),
          schemaName: "wenshan_followup_v1",
          jsonSchema: FOLLOWUP_JSON_SCHEMA as unknown as Record<string, unknown>,
          maxOutputTokens: 3000,
          safetyIdentifier: "eval",
          fakeResponse: () => fakeFollowup(c.followup!),
        });
        const checked = res.kind === "ok" ? validateFollowup(res.data, fctx) : null;
        const content = checked?.ok ? checked.content : null;
        out.push({
          ...metricsBase(c, "followup", res),
          passed: Boolean(checked?.ok),
          issues: checked && !checked.ok ? checked.issues.map((i) => i.code) : res.kind === "ok" ? [] : [res.kind],
          grounded: null,
          unsupportedNumbers: content ? unsupportedNumbers(allText({ ...content, citations: [] }), [...inputs, c.followup]) : [],
          actionExecutable: content?.adjusted_action ? actionExecutable(content.adjusted_action) : null,
          matchesExpectation: content && c.expect.sameMatter !== undefined ? content.is_same_matter === c.expect.sameMatter : null,
        });
      }
    }
  }
  return out;
}

export interface ModelSummary {
  route: string;
  model: string;
  runs: number;
  passRate: number;
  groundedRate: number | null;
  actionRate: number | null;
  unsupportedNumberRuns: number;
  expectationRate: number | null;
  avgLatencyMs: number;
  totalCostUsd: number;
  avgCostUsd: number;
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
  return [...groups.entries()].map(([k, rs]) => {
    const [route, model] = k.split("|") as [string, string];
    const total = rs.reduce((s, r) => s + r.costUsd, 0);
    return {
      route,
      model,
      runs: rs.length,
      passRate: rs.filter((r) => r.passed).length / rs.length,
      groundedRate: rate(rs.map((r) => r.grounded)),
      actionRate: rate(rs.map((r) => r.actionExecutable)),
      unsupportedNumberRuns: rs.filter((r) => r.unsupportedNumbers.length > 0).length,
      expectationRate: rate(rs.map((r) => r.matchesExpectation)),
      avgLatencyMs: Math.round(rs.reduce((s, r) => s + r.latencyMs, 0) / rs.length),
      totalCostUsd: total,
      avgCostUsd: total / rs.length,
    };
  });
}

export function toMarkdown(summary: ModelSummary[], meta: { live: boolean; date: string; cases: number }): string {
  const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
  const lines = [
    `# 模型对照评测 ${meta.date}（${meta.live ? "真实 API" : "本地替身"}，${meta.cases} 个用例）`,
    "",
    "| 环节 | 模型 | 次数 | 通过率 | 原文依据 | 行动可执行 | 含无依据数字 | 符合期望 | 平均耗时 | 平均成本 | 合计成本 |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...summary.map(
      (s) =>
        `| ${s.route} | ${s.model} | ${s.runs} | ${pct(s.passRate)} | ${pct(s.groundedRate)} | ${pct(s.actionRate)} | ${s.unsupportedNumberRuns} | ${pct(s.expectationRate)} | ${s.avgLatencyMs} ms | $${s.avgCostUsd.toFixed(4)} | $${s.totalCostUsd.toFixed(4)} |`,
    ),
    "",
    meta.live ? "成本按 server/llm/usage.ts 的价格表计算，推理 token 已含在输出 token 内。" : "本地替身不产生 token，成本为 0；只验证评测流程本身。",
  ];
  return lines.join("\n");
}
