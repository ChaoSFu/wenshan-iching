import { z } from "zod";

/**
 * 报告与追问的输出结构（技术方案 5.7、5.8）。
 * JSON Schema 按 OpenAI 严格模式书写：所有字段必填、可选用 null 联合、每个对象 additionalProperties: false。
 * 字数上下限不放进 schema，由 zod 和校验器检查。
 */

export const REPORT_SCHEMA_VERSION = "report@1";
export const FOLLOWUP_SCHEMA_VERSION = "followup@1";

const CITATION_PATTERN = "^ZY\\.\\d{2}\\.(G|L[1-6]|Y9|Y6|TUAN|XIANG)$";

const actionJson = {
  type: "object",
  additionalProperties: false,
  required: ["what", "by_when", "feedback_signal"],
  properties: {
    what: { type: "string", description: "具体做什么" },
    by_when: { type: "string", description: "什么时间前做，如「第 3 天前」" },
    feedback_signal: { type: "string", description: "用什么反馈来重新判断" },
  },
} as const;

export const REPORT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["question_summary", "situation", "observations", "to_verify", "seven_day_action", "review_condition", "followup_suggestions"],
  properties: {
    question_summary: { type: "string", description: "问题摘要，不超过 80 字" },
    situation: { type: "string", description: "从用户提供的事实出发描述处境" },
    observations: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["angle", "text", "citations"],
        properties: {
          angle: { type: "string", description: "观察角度，四到八个字" },
          text: { type: "string", description: "结合问题看卦" },
          citations: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", pattern: CITATION_PATTERN } },
        },
      },
    },
    to_verify: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "how"],
        properties: { item: { type: "string" }, how: { type: "string" } },
      },
    },
    seven_day_action: actionJson,
    review_condition: { type: "string", description: "什么情况下回来重新看这件事" },
    followup_suggestions: { type: "array", maxItems: 2, items: { type: "string" } },
  },
} as const;

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

const len = (min: number, max: number) => z.string().trim().min(min).max(max);

const actionZod = z.object({
  what: len(6, 200),
  by_when: len(2, 40),
  feedback_signal: len(6, 160),
});

export const reportZod = z.object({
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
export type ReportContent = z.infer<typeof reportZod>;

export const followupZod = z.object({
  is_same_matter: z.boolean(),
  answer: len(10, 600),
  adjusted_action: actionZod.nullable(),
  citations: z.array(z.string()).max(3),
});
export type FollowupContent = z.infer<typeof followupZod>;
