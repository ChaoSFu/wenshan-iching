import path from "node:path";
import { z } from "zod";

/**
 * 服务端配置（技术方案第 4、10 节）。开发环境下所有外部服务都有本地替身：
 * 不配置 DATABASE_URL 用内嵌的 PGlite；支付、模型、邮件默认用 fake / console。
 * 生产环境禁止使用替身。
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),

  /**
   * normal：按配置使用真实服务或本地替身；
   * simulation：模拟流程（npm run dev:test、worker 集成测试）。外部服务一律用替身，
   * 忽略 DATABASE_URL 与真实密钥，只连指定的测试库；生产环境禁止。
   */
  RUN_MODE: z.enum(["normal", "simulation"]).default("normal"),
  DATABASE_URL: z.string().optional(),
  /** 模拟模式专用的 PostgreSQL 测试库（库名必须含 test）；不填用 PGlite 测试目录 */
  SIMULATION_DATABASE_URL: z.string().optional(),
  /**
   * 模拟模式下的模型：fake（默认，模拟报告）或 openai（用 OPENAI_API_KEY 调真实模型，会计费）。
   * 只放开模型这一项：支付仍是模拟支付页、邮件仍打印在终端、只连测试库（npm run dev:test:llm）。
   */
  SIMULATION_LLM: z.enum(["fake", "openai"]).default("fake"),
  /** 未配置数据库连接串时 PGlite 的数据目录；"memory" 表示只在内存里。模拟模式默认 .data/pglite-test */
  PGLITE_DIR: z.string().optional(),
  /** inline：在 Web 进程里跑后台任务（开发与单机部署）；off：交给独立 worker 进程 */
  WORKER_MODE: z.enum(["inline", "off"]).default("inline"),
  /** 任务租约：worker 崩溃后，running 任务超过这个时长会被重新认领 */
  JOB_LEASE_MS: z.coerce.number().int().positive().default(10 * 60_000),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),

  /** base64 编码的 32 字节密钥，用于字段加密与验证码哈希 */
  DATA_ENCRYPTION_KEY: z.string().optional(),

  MAIL_PROVIDER: z.enum(["console", "resend"]).default("console"),
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default("问山 <no-reply@example.com>"),

  PAYMENT_PROVIDER: z.enum(["fake", "stripe"]).default("fake"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /** 一次付款的金额（最小货币单位）：首发 US$0.99 */
  PRICE_AMOUNT_MINOR: z.coerce.number().int().positive().default(99),
  PRICE_CURRENCY: z.string().length(3).default("usd"),
  PRICE_VERSION: z.string().default("price@2026-11"),
  /** 收款开关：默认关闭。关闭时页面显示"暂未开放"，下单接口拒绝 */
  SALES_ENABLED: z.stringbool().default(false),
  /** 仅测试配置：允许未审核的原文与注释进入付费流程。只能和 PAYMENT_PROVIDER=fake 一起用 */
  ALLOW_UNREVIEWED_CONTENT: z.stringbool().default(false),

  LLM_PROVIDER: z.enum(["fake", "openai"]).default("fake"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL_REPORT: z.string().default("gpt-6.2-sol"),
  OPENAI_MODEL_TRIAGE: z.string().default("gpt-6.1-terra"),
  OPENAI_EFFORT_REPORT: z.enum(["none", "minimal", "low", "medium", "high"]).default("low"),
  OPENAI_EFFORT_TRIAGE: z.enum(["none", "minimal", "low", "medium", "high"]).default("low"),
  /** 追问默认继承报告的模型与推理档位，可单独覆盖 */
  OPENAI_MODEL_FOLLOWUP: z.string().optional(),
  OPENAI_EFFORT_FOLLOWUP: z.enum(["none", "minimal", "low", "medium", "high"]).optional(),
  /** 同一次业务调用里网络、429、5xx 的重发次数。由适配层逐次重发并记录（SDK 自身不重试），与校验失败后的业务重试分开统计 */
  OPENAI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(1),
  /** 一笔订单的报告最多调用模型几次（含校验重试与后台重试） */
  MAX_REPORT_CALLS_PER_ORDER: z.coerce.number().int().min(1).max(20).default(6),

  REFUND_AFTER_HOURS: z.coerce.number().positive().default(24),
  REPORT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),

  /** 对用户公开的客服邮箱（网站或数据库故障时的备用联系方式） */
  SUPPORT_EMAIL: z.string().optional(),
  /** 新工单通知发到这里（运营邮箱）；不填只在后台列表里看 */
  SUPPORT_NOTIFY_EMAIL: z.string().optional(),
  /** 工单在"已解决"后保留描述与联系方式的天数，之后清除 */
  SUPPORT_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
  /** 可以访问运营后台的登录邮箱，逗号分隔 */
  OPS_EMAILS: z.string().default(""),
});

export type Env = Omit<z.infer<typeof schema>, "PGLITE_DIR"> & { PGLITE_DIR: string };

export type Capability = "database" | "payments" | "llm" | "mail";
export const CAPABILITIES: Capability[] = ["database", "payments", "llm", "mail"];

export const CAPABILITY_LABEL: Record<Capability, string> = {
  database: "数据库",
  payments: "支付",
  llm: "模型",
  mail: "邮件",
};

/** 每项能力缺少的配置名（只有变量名，不含值） */
export function capabilityGaps(e: Env = env()): Record<Capability, string[]> {
  const prod = e.NODE_ENV === "production";
  const gaps: Record<Capability, string[]> = { database: [], payments: [], llm: [], mail: [] };
  if (prod) {
    if (!e.DATABASE_URL) gaps.database.push("DATABASE_URL");
    if (!e.DATA_ENCRYPTION_KEY) gaps.database.push("DATA_ENCRYPTION_KEY");
  }
  if (e.PAYMENT_PROVIDER === "stripe") {
    if (!e.STRIPE_SECRET_KEY) gaps.payments.push("STRIPE_SECRET_KEY");
    if (prod && !e.STRIPE_WEBHOOK_SECRET) gaps.payments.push("STRIPE_WEBHOOK_SECRET");
  } else if (prod) gaps.payments.push("PAYMENT_PROVIDER=stripe");
  if (e.LLM_PROVIDER === "openai") {
    if (!e.OPENAI_API_KEY) gaps.llm.push("OPENAI_API_KEY");
  } else if (prod) gaps.llm.push("LLM_PROVIDER=openai");
  if (e.MAIL_PROVIDER === "resend") {
    if (!e.RESEND_API_KEY) gaps.mail.push("RESEND_API_KEY");
    if (prod && e.MAIL_FROM.includes("example.com")) gaps.mail.push("MAIL_FROM（已在 Resend 验证的发件域名）");
  } else if (prod) gaps.mail.push("MAIL_PROVIDER=resend");
  return gaps;
}


let cached: Env | null = null;

/** 没有显式指定时：填了密钥就用真实服务，否则用本地替身 */
function withProviderDefaults(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const raw: Record<string, string | undefined> = { ...source };
  const has = (k: string) => Boolean(raw[k]?.trim());
  raw.PAYMENT_PROVIDER ||= has("STRIPE_SECRET_KEY") ? "stripe" : undefined;
  raw.LLM_PROVIDER ||= has("OPENAI_API_KEY") ? "openai" : undefined;
  raw.MAIL_PROVIDER ||= has("RESEND_API_KEY") ? "resend" : undefined;
  // .env 文件里留空的项按未配置处理
  for (const k of Object.keys(raw)) if (raw[k] === "") delete raw[k];
  return raw;
}

/** 模拟模式只能连测试库：PostgreSQL 库名或 PGlite 目录名必须含 test（或只在内存里） */
export function isTestDatabaseUrl(url: string): boolean {
  try {
    const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
    return /test/i.test(name);
  } catch {
    return false;
  }
}

export function isTestPgliteDir(dir: string): boolean {
  if (dir === "memory") return true;
  return /test/i.test(path.basename(path.resolve(dir)));
}

/**
 * 模拟模式的隔离：在任何连接之前完成。继承来的 DATABASE_URL、.env.local 里的真实密钥一律不用。
 */
function applyRunMode(p: z.infer<typeof schema>): Env {
  if (p.RUN_MODE !== "simulation") return { ...p, PGLITE_DIR: p.PGLITE_DIR ?? ".data/pglite" };
  if (p.NODE_ENV === "production") throw new Error("RUN_MODE=simulation 不能在生产环境使用");
  const dbUrl = p.SIMULATION_DATABASE_URL;
  if (dbUrl && !isTestDatabaseUrl(dbUrl)) {
    throw new Error("模拟模式的 SIMULATION_DATABASE_URL 必须指向测试库（库名含 test）");
  }
  const pgliteDir = p.PGLITE_DIR ?? ".data/pglite-test";
  if (!dbUrl && !isTestPgliteDir(pgliteDir)) {
    throw new Error(`模拟模式的 PGLITE_DIR 必须是测试目录（目录名含 test 或 memory），当前为 ${pgliteDir}`);
  }
  // 显式选择真实模型时只保留 OpenAI 密钥；支付与邮件的密钥照样清空
  const realLlm = p.SIMULATION_LLM === "openai";
  if (realLlm && !p.OPENAI_API_KEY) {
    throw new Error("SIMULATION_LLM=openai 需要 OPENAI_API_KEY：请在 apps/web/.env.local 里填写后重启");
  }
  return {
    ...p,
    DATABASE_URL: dbUrl,
    PGLITE_DIR: pgliteDir,
    PAYMENT_PROVIDER: "fake",
    LLM_PROVIDER: realLlm ? "openai" : "fake",
    MAIL_PROVIDER: "console",
    STRIPE_SECRET_KEY: undefined,
    STRIPE_WEBHOOK_SECRET: undefined,
    OPENAI_API_KEY: realLlm ? p.OPENAI_API_KEY : undefined,
    RESEND_API_KEY: undefined,
  };
}

/** 只解析、不做发布校验（release:check 用它评估给定环境，再逐项列出问题） */
export function parseEnvLenient(source: Record<string, string | undefined>): Env {
  return applyRunMode(schema.parse(withProviderDefaults(source)));
}

/** 解析并校验配置（不缓存） */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const parsed = parseEnvLenient(source);
  if (parsed.ALLOW_UNREVIEWED_CONTENT && parsed.RUN_MODE !== "simulation") {
    throw new Error("ALLOW_UNREVIEWED_CONTENT 只能在模拟模式（RUN_MODE=simulation，npm run dev:test）下使用");
  }
  if (parsed.NODE_ENV === "production" && parsed.SALES_ENABLED) {
    // 开放收款：支付、模型、邮件、数据库全部就绪才能启动；关闭收款时只在用到的地方各自校验
    const g = capabilityGaps(parsed);
    const missing = CAPABILITIES.flatMap((c) => g[c]);
    if (missing.length) throw new Error(`production config incomplete for SALES_ENABLED=true: ${missing.join(", ")}`);
  }
  return parsed;
}

export function env(): Env {
  if (cached) return cached;
  const parsed = parseEnv(process.env);
  cached = parsed;
  if (parsed.NODE_ENV === "production" && !parsed.SALES_ENABLED) {
    const g = capabilityGaps(parsed);
    const off = CAPABILITIES.filter((c) => g[c].length).map((c) => `${c}(${g[c].join(", ")})`);
    if (off.length) console.warn(`[env] sales closed; unavailable: ${off.join("; ")}`);
  }
  if (parsed.NODE_ENV === "development") {
    // 密钥也可能来自全局环境变量；启动时说清楚用的是真实服务还是替身
    const db = parsed.DATABASE_URL ? "postgres" : `pglite(${parsed.PGLITE_DIR})`;
    console.info(
      `[env] mode=${parsed.RUN_MODE} payment=${parsed.PAYMENT_PROVIDER} llm=${parsed.LLM_PROVIDER} mail=${parsed.MAIL_PROVIDER} db=${db} sales=${parsed.SALES_ENABLED ? "on" : "off"}${parsed.ALLOW_UNREVIEWED_CONTENT ? " (unreviewed content allowed: test config)" : ""}`,
    );
    if (parsed.RUN_MODE === "simulation" && parsed.LLM_PROVIDER === "openai") {
      console.warn(
        `[env] simulation with the REAL OpenAI model (billed): triage ${parsed.OPENAI_MODEL_TRIAGE}, report ${parsed.OPENAI_MODEL_REPORT}; at most ${parsed.MAX_REPORT_CALLS_PER_ORDER} report calls per order. Payment is simulated, mail goes to this terminal.`,
      );
    }
  }
  return parsed;
}

/** 仅测试使用：清空缓存，下次 env() 重新读取 process.env */
export function __resetEnvCache(): void {
  cached = null;
}

/** 仅测试使用：覆盖部分配置 */
export function __setEnvForTests(overrides: Partial<Env>): void {
  cached = { ...applyRunMode(schema.parse({ NODE_ENV: "test" })), ...overrides };
}
