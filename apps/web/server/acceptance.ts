import { createHash } from "node:crypto";
import type { Env } from "./env";

/**
 * 真实联调证据（第三轮 P1，附录 F.6）。每次在明确授权的环境里跑完一项真实服务联调
 * （Stripe 测试模式 + 测试卡、OpenAI 合成样例 + 显式预算、Resend 测试收件箱），
 * npm run acceptance 把结果追加到 apps/web/acceptance/live-evidence.json（提交到仓库，不含任何密钥或个人信息）。
 * 发布验收读这份记录：开放收款要求三项都有通过的记录、没有待核实项，且联调后配置没有改动。
 */

export const LIVE_SERVICES = ["stripe", "openai", "resend"] as const;
export type LiveService = (typeof LIVE_SERVICES)[number];

export interface LiveEvidence {
  service: LiveService;
  recordedAt: string;
  /** 联调时的代码提交（工作树有未提交改动时 dirty=true） */
  commit: string;
  dirty: boolean;
  /** 联调时的配置版本（configVersion，不含密钥） */
  configVersion: string;
  /** 例如 "stripe test mode"、"openai synthetic cases, budget US$1" */
  environment: string;
  result: "pass" | "fail";
  checks: { name: string; ok: boolean; detail: string }[];
  /** 自动化覆盖不到、还要人工确认的项（例如经部署地址收到的 webhook、测试收件箱里实际看到的邮件） */
  pending: string[];
}

export interface EvidenceFile {
  version: 1;
  entries: LiveEvidence[];
}

/** 每项联调依赖的非密钥配置：改了其中任何一项，那一项就需要重新联调 */
function material(e: Env): Record<LiveService, unknown> {
  return {
    stripe: { provider: e.PAYMENT_PROVIDER, price: [e.PRICE_VERSION, e.PRICE_AMOUNT_MINOR, e.PRICE_CURRENCY.toLowerCase()] },
    openai: {
      provider: e.LLM_PROVIDER,
      models: [e.OPENAI_MODEL_TRIAGE, e.OPENAI_EFFORT_TRIAGE, e.OPENAI_MODEL_REPORT, e.OPENAI_EFFORT_REPORT, e.OPENAI_MODEL_FOLLOWUP ?? "", e.OPENAI_EFFORT_FOLLOWUP ?? ""],
    },
    resend: { provider: e.MAIL_PROVIDER, from: e.MAIL_FROM },
  };
}

/**
 * 配置版本：影响收款、模型、邮件行为的非密钥配置的摘要（价格、服务提供方、模型与推理档位、发件地址）。
 * 给出 service 时只摘要那一项依赖的配置——改了模型只需要重跑 OpenAI 联调。
 * 不含密钥与站点地址：联调用测试密钥、可以在预发地址上做，上线换正式密钥与正式地址不算配置改动
 * （正式地址上的 webhook 与冒烟检查单独验收）。
 */
export function configVersion(e: Env, service?: LiveService): string {
  const m = material(e);
  return createHash("sha256")
    .update(JSON.stringify(service ? m[service] : m))
    .digest("hex")
    .slice(0, 12);
}

/** 每项服务最近一次的联调记录 */
export function latestEvidence(entries: LiveEvidence[]): Partial<Record<LiveService, LiveEvidence>> {
  const out: Partial<Record<LiveService, LiveEvidence>> = {};
  for (const e of entries) {
    const cur = out[e.service];
    if (!cur || cur.recordedAt < e.recordedAt) out[e.service] = e;
  }
  return out;
}
