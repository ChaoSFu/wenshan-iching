import { z } from "zod";

/**
 * 服务端配置（技术方案第 4、10 节）。开发环境下所有外部服务都有本地替身：
 * 不配置 DATABASE_URL 用内嵌的 PGlite；支付、模型、邮件默认用 fake / console。
 * 生产环境禁止使用替身。
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_URL: z.string().optional(),
  /** 未配置 DATABASE_URL 时 PGlite 的数据目录；"memory" 表示只在内存里 */
  PGLITE_DIR: z.string().default(".data/pglite"),
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
  PRICE_AMOUNT_MINOR: z.coerce.number().int().positive().default(990),
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
  /** SDK 自身的重试次数（429、5xx、网络错误） */
  OPENAI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(1),
  /** 一笔订单的报告最多调用模型几次（含校验重试与后台重试） */
  MAX_REPORT_CALLS_PER_ORDER: z.coerce.number().int().min(1).max(20).default(6),

  REFUND_AFTER_HOURS: z.coerce.number().positive().default(24),
  REPORT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),

  /** 对用户公开的客服邮箱（网站或数据库故障时的备用联系方式） */
  SUPPORT_EMAIL: z.string().optional(),
  /** 新工单通知发到这里（运营邮箱）；不填只在后台列表里看 */
  SUPPORT_NOTIFY_EMAIL: z.string().optional(),
  /** 可以访问运营后台的登录邮箱，逗号分隔 */
  OPS_EMAILS: z.string().default(""),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/** 没有显式指定时：填了密钥就用真实服务，否则用本地替身 */
function withProviderDefaults(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const raw: Record<string, string | undefined> = { ...source };
  const has = (k: string) => Boolean(raw[k]?.trim());
  raw.PAYMENT_PROVIDER ||= has("STRIPE_SECRET_KEY") ? "stripe" : undefined;
  raw.LLM_PROVIDER ||= has("OPENAI_API_KEY") ? "openai" : undefined;
  raw.MAIL_PROVIDER ||= has("RESEND_API_KEY") ? "resend" : undefined;
  // .env 文件里留空的项按未配置处理
  for (const k of Object.keys(raw)) if (raw[k] === "") delete raw[k];
  return raw;
}

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.parse(withProviderDefaults(process.env));
  if (parsed.NODE_ENV === "production") {
    const missing: string[] = [];
    if (!parsed.DATABASE_URL) missing.push("DATABASE_URL");
    if (!parsed.DATA_ENCRYPTION_KEY) missing.push("DATA_ENCRYPTION_KEY");
    if (parsed.PAYMENT_PROVIDER !== "stripe") missing.push("PAYMENT_PROVIDER=stripe");
    if (parsed.PAYMENT_PROVIDER === "stripe" && (!parsed.STRIPE_SECRET_KEY || !parsed.STRIPE_WEBHOOK_SECRET)) {
      missing.push("STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET");
    }
    if (parsed.LLM_PROVIDER !== "openai" || !parsed.OPENAI_API_KEY) missing.push("LLM_PROVIDER=openai + OPENAI_API_KEY");
    if (parsed.MAIL_PROVIDER !== "resend" || !parsed.RESEND_API_KEY) missing.push("MAIL_PROVIDER=resend + RESEND_API_KEY");
    if (parsed.MAIL_FROM.includes("example.com")) missing.push("MAIL_FROM（已在 Resend 验证的发件域名）");
    if (parsed.ALLOW_UNREVIEWED_CONTENT) missing.push("ALLOW_UNREVIEWED_CONTENT 不能在生产环境开启");
    if (missing.length) throw new Error(`production config incomplete: ${missing.join(", ")}`);
  }
  if (parsed.ALLOW_UNREVIEWED_CONTENT && parsed.PAYMENT_PROVIDER !== "fake") {
    throw new Error("ALLOW_UNREVIEWED_CONTENT 只能和 PAYMENT_PROVIDER=fake 一起使用（模拟流程的测试配置）");
  }
  cached = parsed;
  if (parsed.NODE_ENV === "development") {
    // 密钥也可能来自全局环境变量；启动时说清楚用的是真实服务还是替身
    console.info(
      `[env] payment=${parsed.PAYMENT_PROVIDER} llm=${parsed.LLM_PROVIDER} mail=${parsed.MAIL_PROVIDER} db=${parsed.DATABASE_URL ? "postgres" : "pglite"} sales=${parsed.SALES_ENABLED ? "on" : "off"}${parsed.ALLOW_UNREVIEWED_CONTENT ? " (unreviewed content allowed: test config)" : ""}`,
    );
  }
  return parsed;
}

/** 仅测试使用：清空缓存，下次 env() 重新读取 process.env */
export function __resetEnvCache(): void {
  cached = null;
}

/** 仅测试使用：覆盖部分配置 */
export function __setEnvForTests(overrides: Partial<Env>): void {
  cached = { ...schema.parse({ NODE_ENV: "test" }), ...overrides };
}
