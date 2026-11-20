import OpenAI from "openai";
import { env } from "../env";

/**
 * 模型调用的唯一入口（技术方案 5.7 的 llm.generateStructured）。业务代码只依赖这里的接口，
 * 换模型或换服务商只改配置和适配层。开发与测试默认用 fake，不需要 API key。
 */

export type LlmRoute = "triage" | "report" | "followup";

export interface Usage {
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
}

export interface StructuredRequest {
  route: LlmRoute;
  /** 稳定的指令（系统层 + 主题层），放在 developer 消息里，前缀可命中缓存 */
  developer: string;
  /** 本次请求的内容（用户处境、原文等） */
  user: string;
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
  safetyIdentifier: string;
  /** fake 适配层用它产出一份合法的结构化结果 */
  fakeResponse: () => unknown;
}

interface Meta {
  model: string;
  effort: string;
  latencyMs: number;
  usage: Usage;
}

export type StructuredResult =
  | ({ kind: "ok"; data: unknown } & Meta)
  | ({ kind: "refusal"; message: string } & Meta)
  | ({ kind: "incomplete"; reason: string } & Meta);

export interface ModerationResult {
  flagged: boolean;
  categories: string[];
}

export interface LlmProvider {
  readonly name: "openai" | "fake";
  generateStructured(req: StructuredRequest): Promise<StructuredResult>;
  moderate(texts: string[]): Promise<ModerationResult>;
}

/** 429、5xx、网络超时等可以重试的错误 */
export class LlmTransientError extends Error {
  override name = "LlmTransientError";
}

function modelFor(route: LlmRoute): { model: string; effort: "none" | "minimal" | "low" | "medium" | "high" } {
  const e = env();
  return route === "triage"
    ? { model: e.OPENAI_MODEL_TRIAGE, effort: e.OPENAI_EFFORT_TRIAGE }
    : { model: e.OPENAI_MODEL_REPORT, effort: e.OPENAI_EFFORT_REPORT };
}

function createOpenAiProvider(): LlmProvider {
  const client = new OpenAI({ apiKey: env().OPENAI_API_KEY, timeout: 60_000, maxRetries: 2 });

  function wrapError(err: unknown): never {
    if (err instanceof OpenAI.APIConnectionError) throw new LlmTransientError(err.message);
    if (err instanceof OpenAI.APIError && (err.status === 429 || (err.status ?? 0) >= 500)) {
      throw new LlmTransientError(`${err.status} ${err.message}`);
    }
    throw err;
  }

  return {
    name: "openai",

    async generateStructured(req) {
      const { model, effort } = modelFor(req.route);
      const started = Date.now();
      let res: OpenAI.Responses.Response;
      try {
        res = await client.responses.create({
          model,
          input: [
            { role: "developer", content: req.developer },
            { role: "user", content: req.user },
          ],
          text: { format: { type: "json_schema", name: req.schemaName, schema: req.jsonSchema, strict: true } },
          reasoning: { effort },
          // 上下文由我们自己保存，不让 OpenAI 侧保留响应状态（技术方案 8.2）
          store: false,
          max_output_tokens: req.maxOutputTokens,
          safety_identifier: req.safetyIdentifier,
        });
      } catch (err) {
        wrapError(err);
      }
      const meta: Meta = {
        model: res.model ?? model,
        effort,
        latencyMs: Date.now() - started,
        usage: {
          inputTokens: res.usage?.input_tokens ?? null,
          cachedTokens: res.usage?.input_tokens_details?.cached_tokens ?? null,
          outputTokens: res.usage?.output_tokens ?? null,
          reasoningTokens: res.usage?.output_tokens_details?.reasoning_tokens ?? null,
        },
      };
      for (const item of res.output ?? []) {
        if (item.type !== "message") continue;
        for (const part of item.content) {
          if (part.type === "refusal") return { kind: "refusal", message: part.refusal, ...meta };
        }
      }
      if (res.status === "incomplete") {
        return { kind: "incomplete", reason: res.incomplete_details?.reason ?? "unknown", ...meta };
      }
      try {
        return { kind: "ok", data: JSON.parse(res.output_text) as unknown, ...meta };
      } catch {
        return { kind: "incomplete", reason: "invalid_json", ...meta };
      }
    },

    async moderate(texts) {
      try {
        const res = await client.moderations.create({ model: "omni-moderation-latest", input: texts });
        const categories = new Set<string>();
        let flagged = false;
        for (const r of res.results) {
          flagged ||= r.flagged;
          for (const [name, hit] of Object.entries(r.categories)) if (hit) categories.add(name);
        }
        return { flagged, categories: [...categories] };
      } catch (err) {
        wrapError(err);
      }
    },
  };
}

const FAKE_FLAG_WORDS = ["自杀", "自殺", "不想活", "活不下去", "杀了他", "殺了他"];

function createFakeProvider(): LlmProvider {
  if (env().NODE_ENV === "production") throw new Error("fake LLM provider is not allowed in production");
  return {
    name: "fake",
    async generateStructured(req) {
      const started = Date.now();
      await new Promise((r) => setTimeout(r, env().NODE_ENV === "test" ? 0 : 1200));
      return {
        kind: "ok",
        data: req.fakeResponse(),
        model: `fake-${req.route}`,
        effort: "none",
        latencyMs: Date.now() - started,
        usage: { inputTokens: null, cachedTokens: null, outputTokens: null, reasoningTokens: null },
      };
    },
    async moderate(texts) {
      const hit = texts.some((t) => FAKE_FLAG_WORDS.some((w) => t.includes(w)));
      return { flagged: hit, categories: hit ? ["self-harm"] : [] };
    },
  };
}

let provider: LlmProvider | null = null;

export function getLlm(): LlmProvider {
  provider ??= env().LLM_PROVIDER === "openai" ? createOpenAiProvider() : createFakeProvider();
  return provider;
}

export function __setLlmForTests(p: LlmProvider | null): void {
  provider = p;
}
