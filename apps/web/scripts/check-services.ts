/**
 * 检查外部服务是否配置正确（读取 apps/web/.env.local）：
 *   npm run check:services -w @wenshan/web            # 完整检查（OpenAI 部分约 US$0.1）
 *   npm run check:services -w @wenshan/web -- --quick # OpenAI 只确认参数被接受
 *
 * - Stripe：只读查询账户与余额，不创建付款
 * - OpenAI：确认三条路由的模型存在、内容审核可用；再用一份合成样例按线上配置完整走一遍
 *   分流 → 选文快照 → 报告 → 追问（真实业务 schema、业务校验、输出内容审核、带反馈重试），
 *   检查完整输出、拒答、截断（incomplete）与校验结果。不写数据库。
 *   加 --quick 只确认三条路由接受严格 JSON Schema 参数（每次几百个 token）；
 *   未启用 OpenAI 时加 --fake-llm 用替身走一遍完整检查（只验证脚本本身）
 * - Resend：查询发件域名是否已验证，不发送邮件
 * - PostgreSQL（配置了 DATABASE_URL 时）：连接并确认已执行迁移
 */
import { existsSync } from "node:fs";
import OpenAI from "openai";
import Stripe from "stripe";
import { castFromTosses, tossesFromLines } from "@wenshan/iching-core";
import { corpus } from "../server/content";
import { env } from "../server/env";
import { getLlm, routeConfig, type StructuredResult } from "../server/llm";
import { costUsd } from "../server/llm/usage";
import { FOLLOWUP_CALLS_PER_RUN, REPORT_CALLS_PER_RUN, attemptFollowup, attemptReport, type AttemptRun } from "../server/report/attempts";
import { situationOf, validationContext } from "../server/report/generate";
import { FOLLOWUP_JSON_SCHEMA, REPORT_JSON_SCHEMA } from "../server/report/schema";
import { buildSnapshot } from "../server/snapshot";
import { TRIAGE_VERSION, buildTriageRequest, decideTriage } from "../server/triage";

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f);
const QUICK = process.argv.includes("--quick");
const e = env();

let failures = 0;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const warn = (msg: string) => console.log(`  ! ${msg}`);
const fail = (msg: string) => {
  failures++;
  console.log(`  ✗ ${msg}`);
};
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

console.log(
  `当前配置：模式 ${e.RUN_MODE} · 支付 ${e.PAYMENT_PROVIDER} · 模型 ${e.LLM_PROVIDER} · 邮件 ${e.MAIL_PROVIDER} · 数据库 ${e.DATABASE_URL ? "PostgreSQL" : "PGlite（本地）"}`,
);
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
  // --fake-llm：用替身走一遍完整检查，只验证检查脚本本身
  if (process.argv.includes("--fake-llm")) await fullRouteCheck();
} else {
  const client = new OpenAI({ apiKey: e.OPENAI_API_KEY, timeout: 60_000, maxRetries: 0 });
  for (const model of new Set([routeConfig("triage").model, routeConfig("report").model, routeConfig("followup").model])) {
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
  if (QUICK) await quickSchemaCheck(client);
  else await fullRouteCheck();
}

/** --quick：只确认三条路由的模型接受严格 JSON Schema（极小输出上限，结果通常是 incomplete） */
async function quickSchemaCheck(client: OpenAI) {
  const triageSchema = buildTriageRequest({ topicId: "career", question: "检查", context: {} }, "config-check").jsonSchema;
  const routes: [string, "triage" | "report" | "followup", Record<string, unknown>][] = [
    ["分流", "triage", triageSchema],
    ["报告", "report", REPORT_JSON_SCHEMA as unknown as Record<string, unknown>],
    ["追问", "followup", FOLLOWUP_JSON_SCHEMA as unknown as Record<string, unknown>],
  ];
  for (const [label, route, schema] of routes) {
    const { model, effort } = routeConfig(route);
    try {
      const res = await client.responses.create({
        model,
        input: [{ role: "user", content: "这是一次配置检查，请输出符合格式的最短 JSON。" }],
        text: { format: { type: "json_schema", name: `check_${route}`, schema, strict: true } },
        reasoning: { effort },
        store: false,
        max_output_tokens: 64,
        safety_identifier: "config-check",
      });
      ok(`${label}：${model}/${effort} 接受了结构化输出参数（status=${res.status}）`);
    } catch (err) {
      fail(`${label}：${model} 请求被拒：${errMsg(err)}`);
    }
  }
}

function describeCall(r: StructuredResult): string {
  const c = costUsd(r.model, r.usage);
  const cost = c === null ? "成本未知（价格表缺该模型或没有用量）" : `$${c.toFixed(4)}`;
  const retries = r.transportFailures?.length ? ` · 传输重发 ${r.transportFailures.length} 次` : "";
  return `${r.model}/${r.effort} · ${r.latencyMs} ms · 输入 ${r.usage.inputTokens ?? "?"} / 输出 ${r.usage.outputTokens ?? "?"}（推理 ${r.usage.reasoningTokens ?? "?"}）· ${cost}${retries}`;
}

function printRun<T>(label: string, run: AttemptRun<T>): boolean {
  run.attempts.forEach((a, i) => {
    const detail = a.result.kind === "refusal" ? `，拒答：${a.result.message.slice(0, 80)}` : a.issueCodes.length ? `，问题：${a.issueCodes.join(", ")}` : "";
    (a.outcome === "ok" ? ok : warn)(`${label} 第 ${i + 1} 次：${a.outcome}${detail} · ${describeCall(a.result)}`);
  });
  if (run.status === "refusal") fail(`${label}：模型拒答`);
  else if (run.status === "exhausted") fail(`${label}：${run.attempts.length} 次都没有通过业务校验或输出内容审核（incomplete 表示输出被截断）`);
  return run.status === "ok";
}

/** 完整检查（默认）：一份合成样例按线上配置完整走一遍三条路由 */
async function fullRouteCheck() {
  console.log("  完整检查三条路由（合成样例，预计约 US$0.1；只想确认参数可用请加 --quick）");
  const llm = getLlm();
  const cast = castFromTosses(tossesFromLines([9, 7, 7, 7, 7, 7]));
  const reading = {
    id: "check-services",
    clientReadingId: "check-services",
    userId: "check",
    topicId: "career" as const,
    topicOriginal: "career" as const,
    question: "我做后端，现岗位稳定，但考虑转产品岗。每周能抽三小时，目前没有面试。我该怎样用接下来四周试一试？",
    context: { options: "留在现岗位；内部转产品岗" },
    cast,
    corpusVersion: corpus.version,
    revision: 1,
    updatedAt: new Date(),
  };

  let triage;
  try {
    const d = await decideTriage(llm, reading, "config-check");
    if (!d.result) warn("分流：被本地危机规则或输入审核拦下，没有调用模型");
    else if (d.result.kind === "ok") ok(`分流：${d.output?.decision} · ${describeCall(d.result)}`);
    else if (d.result.kind === "refusal") fail(`分流：模型拒答 · ${describeCall(d.result)}`);
    else fail(`分流：输出被截断或不完整（${d.result.reason}）· ${describeCall(d.result)}`);
    triage = d.output;
  } catch (err) {
    fail(`分流请求失败：${errMsg(err)}`);
  }
  if (!triage) return;
  if (triage.decision !== "proceed") warn(`合成样例的分流结果是 ${triage.decision}（预期 proceed），继续检查报告`);

  const { basis, intent } = buildSnapshot(reading, { id: null, version: TRIAGE_VERSION, output: triage }, { includeUnreviewed: true });
  const situation = situationOf(basis, intent);
  const common = { llm, topicId: basis.topicId, cast, passages: basis.passages, situation, safetyIdentifier: "config-check" };

  let reportRun;
  try {
    reportRun = await attemptReport({ ...common, ctx: validationContext(basis.passages, situation), calls: REPORT_CALLS_PER_RUN, routeHint: routeConfig("report") });
  } catch (err) {
    fail(`报告请求失败：${errMsg(err)}`);
    return;
  }
  if (!printRun("报告", reportRun) || reportRun.status !== "ok") {
    warn("追问：报告没有通过，追问不运行");
    return;
  }

  const question = "我没有正式的产品项目，可以拿哪种后端项目当案例？";
  const ctx = validationContext(basis.passages, situation);
  ctx.quotableSources.push(question);
  try {
    const fu = await attemptFollowup({
      ...common,
      ctx,
      calls: FOLLOWUP_CALLS_PER_RUN,
      routeHint: routeConfig("followup"),
      report: reportRun.content,
      previous: [],
      question,
    });
    if (printRun("追问", fu) && fu.status === "ok" && !fu.content.is_same_matter) warn("追问：模型判断不是同一件事（预期是同一件事）");
  } catch (err) {
    fail(`追问请求失败：${errMsg(err)}`);
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
