import type { Cast } from "@wenshan/iching-core";
import { LlmTransientError, type Effort, type LlmProvider, type StructuredResult, type TransportFailure } from "../llm";
import { fakeFollowup, fakeReport } from "./fake";
import { castSummary, type AllowedPassage } from "./passages";
import { FOLLOWUP_DEVELOPER_SUFFIX, developerPrompt, followupUserPrompt, reportUserPrompt, type UserSituation } from "./prompt";
import { FOLLOWUP_JSON_SCHEMA, REPORT_JSON_SCHEMA, type AnyReportContent, type FollowupContent, type ReportContent } from "./schema";
import { allText, validateFollowup, validateReport, type ValidationContext } from "./validate";

/**
 * 报告与追问的"生成 → 业务校验 → 输出内容审核 → 带反馈重试"循环。
 * 付费履约（report/generate.ts）与模型评测（eval/run.ts）共用这一份，评测结果才代表线上表现。
 * 这里不碰数据库：调用额度、用量记录由调用方通过回调提供。
 */

/** 一次生成任务里最多两次模型调用：首次 + 校验失败后带反馈重试一次（PRD §7） */
export const REPORT_CALLS_PER_RUN = 2;
export const FOLLOWUP_CALLS_PER_RUN = 2;

export type AttemptOutcome = "ok" | "invalid" | "moderation_flagged" | "refusal" | "incomplete";

export interface BusinessAttempt {
  call: number;
  result: StructuredResult;
  outcome: AttemptOutcome;
  /** 业务校验的问题（给模型的反馈与记录用） */
  issues: string[];
  issueCodes: string[];
  /** 输出内容审核命中的类别 */
  moderationCategories: string[];
}

export interface AttemptHooks {
  /** 每次调用前占用额度；返回 false 表示已达上限 */
  reserve?: () => Promise<boolean>;
  /** 每次业务调用之后（含失败） */
  onAttempt?: (a: BusinessAttempt) => Promise<void>;
  /** 所有发送都失败时（随后抛出 LlmTransientError） */
  onTransportExhausted?: (failures: TransportFailure[], route: { model: string; effort: string }) => Promise<void>;
}

export type AttemptRun<T> =
  | { status: "ok"; content: T; result: StructuredResult; attempts: BusinessAttempt[] }
  | { status: "refusal"; attempts: BusinessAttempt[] }
  | { status: "exhausted"; attempts: BusinessAttempt[] }
  | { status: "call_limit"; attempts: BusinessAttempt[] };

interface Common {
  llm: LlmProvider;
  topicId: UserSituation["topicId"];
  cast: Cast;
  passages: AllowedPassage[];
  situation: UserSituation;
  ctx: ValidationContext;
  safetyIdentifier: string;
  calls: number;
  /** 评测时指定模型；业务调用不传，用路由配置 */
  override?: { model: string; effort: Effort };
  /** 用于记录请求异常时的模型名（业务调用传路由配置） */
  routeHint: { model: string; effort: string };
  hooks?: AttemptHooks;
}

async function loop<T>(
  c: Common,
  send: (feedback: string[]) => Promise<StructuredResult>,
  validate: (data: unknown) => { ok: true; content: T } | { ok: false; issues: { code: string; message: string }[] },
  textOf: (content: T) => string,
  incompleteFeedback: (reason: string) => string,
): Promise<AttemptRun<T>> {
  const attempts: BusinessAttempt[] = [];
  let feedback: string[] = [];
  for (let call = 1; call <= c.calls; call++) {
    if (c.hooks?.reserve && !(await c.hooks.reserve())) return { status: "call_limit", attempts };
    let res: StructuredResult;
    try {
      res = await send(feedback);
    } catch (err) {
      if (err instanceof LlmTransientError) await c.hooks?.onTransportExhausted?.(err.transportFailures, c.override ?? c.routeHint);
      throw err;
    }
    const base = { call, result: res, issues: [] as string[], issueCodes: [] as string[], moderationCategories: [] as string[] };
    if (res.kind === "refusal") {
      const a: BusinessAttempt = { ...base, outcome: "refusal" };
      attempts.push(a);
      await c.hooks?.onAttempt?.(a);
      return { status: "refusal", attempts };
    }
    if (res.kind === "incomplete") {
      const a: BusinessAttempt = { ...base, outcome: "incomplete", issueCodes: [`incomplete:${res.reason}`] };
      attempts.push(a);
      await c.hooks?.onAttempt?.(a);
      feedback = [incompleteFeedback(res.reason)];
      continue;
    }
    const checked = validate(res.data);
    if (!checked.ok) {
      const a: BusinessAttempt = { ...base, outcome: "invalid", issues: checked.issues.map((i) => i.message), issueCodes: checked.issues.map((i) => i.code) };
      attempts.push(a);
      await c.hooks?.onAttempt?.(a);
      feedback = a.issues;
      continue;
    }
    const moderation = await c.llm.moderate([textOf(checked.content)]);
    if (moderation.flagged) {
      const a: BusinessAttempt = {
        ...base,
        outcome: "moderation_flagged",
        issues: [`内容审核未通过：${moderation.categories.join(", ")}`],
        issueCodes: moderation.categories.map((x) => `moderation:${x}`),
        moderationCategories: moderation.categories.length ? moderation.categories : ["flagged"],
      };
      attempts.push(a);
      await c.hooks?.onAttempt?.(a);
      feedback = a.issues;
      continue;
    }
    const a: BusinessAttempt = { ...base, outcome: "ok" };
    attempts.push(a);
    await c.hooks?.onAttempt?.(a);
    return { status: "ok", content: checked.content, result: res, attempts };
  }
  return { status: "exhausted", attempts };
}

export function attemptReport(c: Common): Promise<AttemptRun<ReportContent>> {
  return loop(
    c,
    (feedback) =>
      c.llm.generateStructured({
        route: "report",
        override: c.override,
        developer: developerPrompt(c.topicId),
        user: reportUserPrompt({ castSummary: castSummary(c.cast), passages: c.passages, situation: c.situation, feedback }),
        schemaName: "wenshan_report_v2",
        jsonSchema: REPORT_JSON_SCHEMA as unknown as Record<string, unknown>,
        maxOutputTokens: 6000,
        safetyIdentifier: c.safetyIdentifier,
        fakeResponse: () => fakeReport(c.passages, c.situation),
      }),
    (data) => validateReport(data, c.ctx),
    (content) => allText(content),
    (reason) => `输出不完整（${reason}），请把 takeaway 与 next_step 控制在 250 字以内并输出完整 JSON`,
  );
}

export function attemptFollowup(
  c: Common & { report: AnyReportContent; previous: { question: string; answer: string }[]; question: string },
): Promise<AttemptRun<FollowupContent>> {
  return loop(
    c,
    (feedback) =>
      c.llm.generateStructured({
        route: "followup",
        override: c.override,
        developer: developerPrompt(c.topicId) + FOLLOWUP_DEVELOPER_SUFFIX,
        user: followupUserPrompt({
          castSummary: castSummary(c.cast),
          passages: c.passages,
          situation: c.situation,
          report: c.report,
          previous: c.previous,
          question: c.question,
          feedback,
        }),
        schemaName: "wenshan_followup_v1",
        jsonSchema: FOLLOWUP_JSON_SCHEMA as unknown as Record<string, unknown>,
        maxOutputTokens: 3000,
        safetyIdentifier: c.safetyIdentifier,
        fakeResponse: () => fakeFollowup(c.question),
      }),
    (data) => validateFollowup(data, c.ctx),
    (content) => allText(content),
    () => "输出不完整，请缩短回答并输出完整 JSON",
  );
}
