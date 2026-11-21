import { z } from "zod";

/**
 * 报告与追问的输出结构（技术方案 5.7、5.8，附录 G）。
 * JSON Schema 按 OpenAI 严格模式书写：所有字段必填、可选用 null 联合、每个对象 additionalProperties: false。
 * 字数上下限不放进 schema，由 zod 和校验器检查。
 *
 * report@2（第四轮，简版）：一句直接回应（takeaway）→ 下一步（next_step）→ 为什么这样看（basis）→ 可选的可复制材料（artifact）。
 * report@1（旧版）：问题摘要、处境、观察、核实清单、七天行动、回看条件。旧报告照常可读、可导出、可追问。
 */

export const REPORT_SCHEMA_VERSION = "report@2";
export const LEGACY_REPORT_SCHEMA_VERSION = "report@1";
export const FOLLOWUP_SCHEMA_VERSION = "followup@1";

const CITATION_PATTERN = "^ZY\\.\\d{2}\\.(G|L[1-6]|Y9|Y6|TUAN|XIANG)$";

const actionJson = {
  type: "object",
  additionalProperties: false,
  required: ["what", "by_when", "feedback_signal"],
  properties: {
    what: { type: "string", description: "具体做什么" },
    by_when: { type: "string", description: "什么时间前、或什么情况下做" },
    feedback_signal: { type: "string", description: "用什么反馈来重新判断" },
  },
} as const;

// ---------------------------------------------------------------- report@2

export const ARTIFACT_KINDS = ["message", "opener", "checklist"] as const;

export const REPORT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["takeaway", "next_step", "basis", "artifact", "followup_suggestions"],
  properties: {
    takeaway: { type: "string", description: "一句话直接回应用户的问题，给出这一卦指向的方向，不超过 60 字" },
    next_step: {
      type: "object",
      additionalProperties: false,
      required: ["trigger", "action", "signal"],
      properties: {
        trigger: { type: "string", description: "什么情况下、什么时间点做；用户没给日期时写成条件" },
        action: { type: "string", description: "对谁、做什么、怎么做" },
        signal: { type: "string", description: "用什么回应或变化判断进展，以及接下来怎么调整" },
      },
    },
    basis: {
      type: "array",
      minItems: 1,
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["citation", "text"],
        properties: {
          citation: { type: "string", pattern: CITATION_PATTERN },
          text: { type: "string", description: "这条原文为什么支持 takeaway；不复述整句原文" },
        },
      },
    },
    artifact: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "title", "content"],
          properties: {
            kind: { type: "string", enum: [...ARTIFACT_KINDS], description: "message 跟进消息；opener 谈话开场；checklist 选择清单" },
            title: { type: "string" },
            content: { type: "string", description: "用户照着就能用的文字；需要用户自己填的地方用【】标出" },
          },
        },
        { type: "null" },
      ],
    },
    followup_suggestions: { type: "array", maxItems: 2, items: { type: "string" } },
  },
} as const;

const len = (min: number, max: number) => z.string().trim().min(min).max(max);

export const reportZod = z.object({
  takeaway: len(8, 70),
  next_step: z.object({
    trigger: len(4, 90),
    action: len(8, 140),
    signal: len(6, 110),
  }),
  basis: z
    .array(z.object({ citation: z.string(), text: len(8, 160) }))
    .min(1)
    .max(2),
  artifact: z
    .object({
      kind: z.enum(ARTIFACT_KINDS),
      title: len(2, 24),
      content: len(8, 500),
    })
    .nullable(),
  followup_suggestions: z.array(len(4, 60)).max(2),
});
/** 新生成的报告（report@2） */
export type ReportContent = z.infer<typeof reportZod>;

/** 主文：一句判断 + 下一步（原文详情与可复制材料另计），建议约 250 字 */
export function mainText(r: ReportContent): string {
  return [r.takeaway, r.next_step.trigger, r.next_step.action, r.next_step.signal].join("");
}
export const MAIN_TEXT_TARGET = 250;
/** 校验上限：留出余量，避免为几个字反复重试 */
export const MAIN_TEXT_LIMIT = 320;

// ---------------------------------------------------------------- report@1（旧版，只读）

const actionZod = z.object({
  what: len(6, 200),
  by_when: len(2, 40),
  feedback_signal: len(6, 160),
});

export const legacyReportZod = z.object({
  question_summary: len(4, 80),
  situation: len(20, 400),
  observations: z
    .array(z.object({ angle: len(2, 16), text: len(20, 400), citations: z.array(z.string()).min(1).max(3) }))
    .min(1)
    .max(3),
  to_verify: z.array(z.object({ item: len(2, 80), how: len(4, 160) })).min(1).max(4),
  seven_day_action: actionZod,
  review_condition: len(6, 200),
  followup_suggestions: z.array(len(4, 80)).max(2),
});
export type LegacyReportContent = z.infer<typeof legacyReportZod>;

/** 数据库里可能存在的两种报告 */
export type AnyReportContent = ReportContent | LegacyReportContent;
export type ReportFormat = "v1" | "v2";

export function reportFormat(content: AnyReportContent, schemaVersion?: string): ReportFormat {
  if (schemaVersion === LEGACY_REPORT_SCHEMA_VERSION) return "v1";
  if (schemaVersion === REPORT_SCHEMA_VERSION) return "v2";
  return "takeaway" in content ? "v2" : "v1";
}

/** 报告引用的原文编号（两种格式通用） */
export function reportCitations(content: AnyReportContent): string[] {
  return "takeaway" in content ? content.basis.map((b) => b.citation) : content.observations.flatMap((o) => o.citations);
}

// ---------------------------------------------------------------- 追问（两种报告共用）

export const FOLLOWUP_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_same_matter", "answer", "adjusted_action", "citations"],
  properties: {
    is_same_matter: { type: "boolean", description: "追问是否仍是报告里的同一件事" },
    answer: { type: "string" },
    adjusted_action: { anyOf: [actionJson, { type: "null" }] },
    citations: { type: "array", maxItems: 3, items: { type: "string", pattern: CITATION_PATTERN } },
  },
} as const;

export const followupZod = z.object({
  is_same_matter: z.boolean(),
  answer: len(10, 600),
  adjusted_action: actionZod.nullable(),
  citations: z.array(z.string()).max(3),
});
export type FollowupContent = z.infer<typeof followupZod>;
