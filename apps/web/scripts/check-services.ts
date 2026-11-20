/**
 * 检查外部服务是否配置正确（读取 apps/web/.env.local）：
 *   npm run check:services -w @wenshan/web
 *
 * - Stripe：只读查询账户与余额，不创建付款
 * - OpenAI：确认模型存在；调用免费的内容审核；再用极小的输出上限各发一次分流、报告、追问请求，
 *   确认严格 JSON Schema 被接受（每次只消耗几百个 token）
 * - Resend：查询发件域名是否已验证，不发送邮件
 * - PostgreSQL（配置了 DATABASE_URL 时）：连接并确认已执行迁移
 */
import { existsSync } from "node:fs";
import OpenAI from "openai";
import Stripe from "stripe";
import { env } from "../server/env";
import { FOLLOWUP_JSON_SCHEMA, REPORT_JSON_SCHEMA } from "../server/report/schema";

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f);
const e = env();

let failures = 0;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const warn = (msg: string) => console.log(`  ! ${msg}`);
const fail = (msg: string) => {
  failures++;
  console.log(`  ✗ ${msg}`);
};
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

console.log(`当前配置：支付 ${e.PAYMENT_PROVIDER} · 模型 ${e.LLM_PROVIDER} · 邮件 ${e.MAIL_PROVIDER} · 数据库 ${e.DATABASE_URL ? "PostgreSQL" : "PGlite（本地）"}`);
console.log(`加密密钥：${e.DATA_ENCRYPTION_KEY ? "已配置" : "未配置（开发环境会用不安全的默认密钥）"}\n`);

// ---------- Stripe ----------
console.log("Stripe");
if (e.PAYMENT_PROVIDER !== "stripe") {
  warn("未启用（PAYMENT_PROVIDER=fake），使用本地模拟支付页");
} else {
  const key = e.STRIPE_SECRET_KEY ?? "";
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) warn("这是正式环境（live）密钥；本地测试请用 sk_test_ 开头的测试密钥");
  else if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) ok("测试模式密钥");
  else fail("STRIPE_SECRET_KEY 格式不对（应以 sk_test_ 开头）");
  try {
    const stripe = new Stripe(key);
    const account = await stripe.accounts.retrieveCurrent();
    ok(`账户 ${account.id} · 国家/地区 ${account.country ?? "未知"} · 默认币种 ${account.default_currency ?? "未知"}`);
    if (account.country && ["TH", "JP", "MX"].includes(account.country)) {
      warn("Stripe 在泰国、日本、墨西哥禁止占卜类业务（见技术方案 §2-8），请确认账户所在地");
    }
    const balance = await stripe.balance.retrieve();
    ok(`API 可用（余额币种：${balance.available.map((b) => b.currency).join(", ") || "无"}）`);
  } catch (err) {
    fail(`调用失败：${errMsg(err)}`);
  }
  if (!e.STRIPE_WEBHOOK_SECRET) {
    warn("未配置 STRIPE_WEBHOOK_SECRET：付款仍可通过支付成功页与对账任务确认，但收不到退款与拒付回调");
  } else if (!e.STRIPE_WEBHOOK_SECRET.startsWith("whsec_")) {
    fail("STRIPE_WEBHOOK_SECRET 应以 whsec_ 开头");
  } else {
    ok("已配置 webhook 签名密钥");
  }
}

// ---------- OpenAI ----------
console.log("\nOpenAI");
if (e.LLM_PROVIDER !== "openai") {
  warn("未启用（LLM_PROVIDER=fake），使用模拟报告");
} else {
  const client = new OpenAI({ apiKey: e.OPENAI_API_KEY, timeout: 60_000, maxRetries: 1 });
  for (const model of new Set([e.OPENAI_MODEL_REPORT, e.OPENAI_MODEL_TRIAGE])) {
    try {
      await client.models.retrieve(model);
      ok(`模型 ${model} 可用`);
    } catch (err) {
      fail(`模型 ${model} 不可用：${errMsg(err)}`);
    }
  }
  try {
    const m = await client.moderations.create({ model: "omni-moderation-latest", input: ["我想换一份工作"] });
    ok(`内容审核接口可用（测试句 flagged=${m.results[0]?.flagged}）`);
  } catch (err) {
    fail(`内容审核接口失败：${errMsg(err)}`);
  }

  const schemas: [string, string, string, Record<string, unknown>][] = [
    ["分流", e.OPENAI_MODEL_TRIAGE, e.OPENAI_EFFORT_TRIAGE, { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } }],
    ["报告", e.OPENAI_MODEL_REPORT, e.OPENAI_EFFORT_REPORT, REPORT_JSON_SCHEMA as unknown as Record<string, unknown>],
    ["追问", e.OPENAI_MODEL_REPORT, e.OPENAI_EFFORT_REPORT, FOLLOWUP_JSON_SCHEMA as unknown as Record<string, unknown>],
  ];
  for (const [label, model, effort, schema] of schemas) {
    try {
      const res = await client.responses.create({
        model,
        input: [{ role: "user", content: "这是一次配置检查，请输出符合格式的最短 JSON。" }],
        text: { format: { type: "json_schema", name: `check_${label === "分流" ? "triage" : label === "报告" ? "report" : "followup"}`, schema, strict: true } },
        reasoning: { effort: effort as "low" },
        store: false,
        max_output_tokens: 64,
        safety_identifier: "config-check",
      });
      ok(`${label}：${model} 接受了结构化输出参数（status=${res.status}，输入 ${res.usage?.input_tokens ?? "?"} / 输出 ${res.usage?.output_tokens ?? "?"} token）`);
    } catch (err) {
      fail(`${label}：${model} 请求被拒：${errMsg(err)}`);
    }
  }
}

// ---------- Resend ----------
console.log("\nResend");
if (e.MAIL_PROVIDER !== "resend") {
  warn("未启用（MAIL_PROVIDER=console），验证码打印在终端里");
} else {
  const fromDomain = e.MAIL_FROM.match(/@([^>\s]+)/)?.[1]?.toLowerCase() ?? "";
  if (fromDomain === "example.com") fail("MAIL_FROM 还是示例地址，请改成已在 Resend 验证的域名");
  if (fromDomain === "resend.dev") warn("使用 resend.dev 测试发件地址：只能发到 Resend 账户本人的邮箱");
  try {
    const res = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${e.RESEND_API_KEY}` } });
    if (res.status === 401 || res.status === 403) {
      warn("这个密钥只有发送权限，无法查询域名；请在 Resend 后台确认发件域名已验证");
    } else if (!res.ok) {
      fail(`查询域名失败：HTTP ${res.status}`);
    } else {
      const body = (await res.json()) as { data?: { name: string; status: string }[] };
      const domains = body.data ?? [];
      ok(`密钥可用，域名：${domains.map((d) => `${d.name}（${d.status}）`).join("，") || "无"}`);
      const match = domains.find((d) => d.name.toLowerCase() === fromDomain);
      if (fromDomain !== "resend.dev" && (!match || match.status !== "verified")) fail(`MAIL_FROM 的域名 ${fromDomain} 尚未在 Resend 验证`);
    }
  } catch (err) {
    fail(`调用失败：${errMsg(err)}`);
  }
}

// ---------- PostgreSQL ----------
if (e.DATABASE_URL) {
  console.log("\nPostgreSQL");
  try {
    const { default: postgres } = await import("postgres");
    const sql = postgres(e.DATABASE_URL, { max: 1, connect_timeout: 10 });
    const rows = await sql`select to_regclass('public.orders') as orders`;
    if (rows[0]?.orders) ok("已连接，迁移已执行");
    else fail("已连接，但还没有执行迁移：npm run db:migrate -w @wenshan/web");
    await sql.end();
  } catch (err) {
    fail(`连接失败：${errMsg(err)}`);
  }
}

console.log(failures ? `\n${failures} 项未通过` : "\n全部检查通过");
process.exit(failures ? 1 : 0);
