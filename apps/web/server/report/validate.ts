import { followupZod, reportZod, type FollowupContent, type ReportContent } from "./schema";

/**
 * 报告复核（技术方案 5.7 校验器，PRD §7「复核与呈现」「积极引导的验收标准」）。
 * 只做确定性检查；内容审核接口的结果由调用方传入。
 */
export const VALIDATOR_VERSION = "validator@1";

export interface ValidationIssue {
  code: string;
  message: string;
}

export interface ValidationContext {
  allowedIds: Set<string>;
  /** 允许在「」里出现的原文：原文、白话注释、用户自己的问题与背景 */
  quotableSources: string[];
}

interface Rule {
  code: string;
  pattern: RegExp;
  message: string;
}

/** 禁用断言词表（v1）。写得窄一些，避免误伤「不一定能」这类正常表述 */
export const FORBIDDEN_RULES: Rule[] = [
  { code: "fatalism", pattern: /注定|命中注定|宿命|天意如此|命该如此|劫数/, message: "出现宿命论表述" },
  {
    code: "guarantee",
    pattern: /(?<!不)(一定会|一定能|必然会?|肯定能)(成功|通过|考上|复合|回来|赚|赢|升职|拿到)|百分之百|稳赚|包过|保证你|保证能/,
    message: "出现保证结果的表述",
  },
  {
    // 只拦"付费化解"：法事、符咒、转运物品、花钱化解等。「以正道化解问题」这类正常用法不拦
    code: "paid_remedy",
    pattern: /法事|符咒|开光|风水摆件|请神|改运|破财消灾|转运(符|珠|手链|石|物品|服务)|(花钱|付费|购买|请人|请大师)[^。；]{0,8}化解|化解[^。；]{0,6}(费用|服务|法器|仪式)/,
    message: "出现付费化解类表述",
  },
  {
    code: "motive_assertion",
    pattern: /(他|她|对方|老板|上司|伴侣|家人|父母)(心里)?(一定|肯定|绝对|其实就)(是|会|在|想|不)/,
    message: "断言他人的想法或动机",
  },
  { code: "medical", pattern: /剂量|处方|服用[^。；]{0,6}(药|片)|停药|确诊为/, message: "出现医疗指导" },
  { code: "investment", pattern: /收益率|必涨|会涨|会跌|建议买入|建议卖出|抄底/, message: "出现投资收益判断" },
  { code: "legal", pattern: /胜诉|败诉|一定能赢|稳赢|判多久/, message: "出现法律结果判断" },
];

function collectText(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectText(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectText(v, out);
  return out;
}

function checkText(text: string, ctx: ValidationContext, issues: ValidationIssue[]): void {
  for (const r of FORBIDDEN_RULES) {
    const m = text.match(r.pattern);
    if (m) issues.push({ code: r.code, message: `${r.message}：「${m[0]}」` });
  }
  // 「」里的内容如果有三个字以上，必须能在原文、白话或用户自己的话里找到，防止错引、编造原文
  for (const m of text.matchAll(/「([^」]{3,})」/g)) {
    const quoted = m[1]!.replace(/[，。；：、！？\s]/g, "");
    const found = ctx.quotableSources.some((s) => s.replace(/[，。；：、！？\s]/g, "").includes(quoted));
    if (!found) issues.push({ code: "unverified_quote", message: `引号内的文字在原文与用户描述中找不到：「${m[1]}」` });
  }
}

function checkCitations(ids: string[], ctx: ValidationContext, issues: ValidationIssue[]): void {
  for (const id of ids) {
    if (!ctx.allowedIds.has(id)) issues.push({ code: "bad_citation", message: `引用了本次不允许的原文编号 ${id}` });
  }
}

export function validateReport(data: unknown, ctx: ValidationContext): { ok: true; content: ReportContent } | { ok: false; issues: ValidationIssue[] } {
  const parsed = reportZod.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ code: "schema", message: `${i.path.join(".")}: ${i.message}` })),
    };
  }
  const issues: ValidationIssue[] = [];
  for (const o of parsed.data.observations) checkCitations(o.citations, ctx, issues);
  for (const t of collectText(parsed.data)) checkText(t, ctx, issues);
  return issues.length ? { ok: false, issues } : { ok: true, content: parsed.data };
}

export function validateFollowup(
  data: unknown,
  ctx: ValidationContext,
): { ok: true; content: FollowupContent } | { ok: false; issues: ValidationIssue[] } {
  const parsed = followupZod.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ code: "schema", message: `${i.path.join(".")}: ${i.message}` })),
    };
  }
  const issues: ValidationIssue[] = [];
  checkCitations(parsed.data.citations, ctx, issues);
  for (const t of collectText(parsed.data)) checkText(t, ctx, issues);
  return issues.length ? { ok: false, issues } : { ok: true, content: parsed.data };
}

export function allText(value: unknown): string {
  return collectText(value).join("\n");
}
