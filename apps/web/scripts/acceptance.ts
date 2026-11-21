/**
 * 真实联调（第三轮 P1，附录 F.6）。会调用真实服务，所以只在显式授权的环境里、加 --yes 才运行；
 * 每次运行把结果（提交、配置版本、每项检查、待核实项）追加到 acceptance/live-evidence.json，发布验收读取它。
 *
 *   npm run acceptance -w @wenshan/web -- --service=stripe --env-file=.env.local --yes
 *       Stripe 测试模式（只接受 sk_test_/rk_test_ 密钥）：Checkout 幂等契约、按尝试 ID 对账、关闭会话；
 *       用测试卡付款后的退款契约（同一键同一笔、元数据带回尝试 ID、全额退后再退被拒）。
 *   npm run acceptance -w @wenshan/web -- --service=openai --env-file=.env.local --budget-usd=1 --yes [--allow-unreviewed]
 *       用合成样例走一遍三条模型路由（分流、报告、追问），与线上同一条路径；超出预算立即停止。
 *       默认只用已审内容（与真实收款一致）；内容未审完时可加 --allow-unreviewed，结果会标为待核实。
 *   npm run acceptance -w @wenshan/web -- --service=resend --env-file=.env.local --yes [--to=delivered@resend.dev]
 *       Resend：同一幂等键发两次只产生一封；默认发到 Resend 的测试地址，发到别的地址需加 --confirm-test-inbox。
 *   npm run acceptance -w @wenshan/web -- --service=stripe --provider=fake
 *       不联网：对本地替身跑同一套检查（验证脚本本身），不写联调记录。
 *
 * 不输出、不记录任何密钥；记录里只有配置版本（非密钥配置的摘要）。
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EvidenceFile, LiveEvidence, LiveService } from "../server/acceptance";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const ALLOWED = new Set(["service", "env-file", "yes", "budget-usd", "allow-unreviewed", "to", "confirm-test-inbox", "provider"]);

function die(msg: string, code = 2): never {
  console.error(`acceptance: ${msg}`);
  process.exit(code);
}

const opts = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
  if (!m || !ALLOWED.has(m[1]!)) die(`未知参数 ${a}`);
  opts.set(m[1]!, m[2] ?? "true");
}
const service = opts.get("service") as LiveService | undefined;
if (!service || !["stripe", "openai", "resend"].includes(service)) die("--service 只能是 stripe、openai 或 resend");
const dryRun = opts.get("provider") === "fake";
if (opts.has("provider") && !dryRun) die("--provider 只能是 fake（不联网的脚本自检）");
const envFile = opts.get("env-file");
if (envFile) {
  if (!existsSync(envFile)) die(`找不到配置文件 ${envFile}`);
  process.loadEnvFile(envFile);
}
if (!dryRun && !opts.has("yes")) die("这会调用真实服务并可能产生费用；确认环境已获授权后加 --yes 再运行");

// 联调不连数据库，也不使用模拟模式
delete process.env.DATABASE_URL;
process.env.RUN_MODE = "normal";
(process.env as Record<string, string>).NODE_ENV = "development";
if (dryRun) {
  process.env.PAYMENT_PROVIDER = "fake";
  process.env.LLM_PROVIDER = "fake";
}

const { env } = await import("../server/env");
const { configVersion } = await import("../server/acceptance");
const e = env();

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const pending: string[] = [];
let environment = "";

if (service === "stripe") {
  if (!dryRun) {
    const key = e.STRIPE_SECRET_KEY ?? "";
    if (e.PAYMENT_PROVIDER !== "stripe" || !key) die("需要 PAYMENT_PROVIDER=stripe 与 STRIPE_SECRET_KEY");
    if (!/^(sk|rk)_test_/.test(key)) die("只接受 Stripe 测试模式密钥（sk_test_ / rk_test_）；正式密钥不用于联调");
  }
  environment = dryRun ? "fake provider (dry run)" : "stripe test mode";
  const { getPaymentProvider } = await import("../server/payments");
  const { runCheckoutContract, runRefundContract } = await import("../server/payments/contract");
  const provider = getPaymentProvider();
  checks.push(...(await runCheckoutContract(provider, { email: "acceptance@example.com", amountMinor: e.PRICE_AMOUNT_MINOR, currency: e.PRICE_CURRENCY, appUrl: e.APP_URL })));
  let paymentId: string | null = null;
  try {
    if (dryRun) {
      const { completeFakeCheckout } = await import("../server/payments/fake");
      const s = await provider.createCheckout({
        orderId: randomUUID(),
        attemptId: randomUUID(),
        amountMinor: e.PRICE_AMOUNT_MINOR,
        currency: e.PRICE_CURRENCY,
        email: "acceptance@example.com",
        description: "acceptance",
        successUrl: `${e.APP_URL}/`,
        cancelUrl: `${e.APP_URL}/`,
        expiresAt: new Date(Date.now() + 40 * 60_000),
        idempotencyKey: `acceptance:${randomUUID()}`,
      });
      completeFakeCheckout(s.sessionId);
      paymentId = (await provider.retrieveCheckout(s.sessionId)).paymentId;
    } else {
      // 测试卡 pm_card_visa 直接确认一笔付款，用来验证退款契约（Checkout 页面付款见待核实项）
      const Stripe = (await import("stripe")).default;
      const stripe = new Stripe(e.STRIPE_SECRET_KEY!);
      const pi = await stripe.paymentIntents.create(
        {
          amount: e.PRICE_AMOUNT_MINOR,
          currency: e.PRICE_CURRENCY,
          payment_method: "pm_card_visa",
          confirm: true,
          automatic_payment_methods: { enabled: true, allow_redirects: "never" },
          metadata: { purpose: "wenshan-acceptance" },
        },
        { idempotencyKey: `acceptance-pi:${randomUUID()}` },
      );
      paymentId = pi.id;
    }
    checks.push({ name: "test payment for refund checks", ok: Boolean(paymentId), detail: paymentId ?? "no payment id" });
  } catch (err) {
    checks.push({ name: "test payment for refund checks", ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
  if (paymentId) checks.push(...(await runRefundContract(provider, paymentId)));
  pending.push(
    "在部署地址（或 stripe listen 转发）用测试卡 4242 4242 4242 4242 在 Checkout 页面付款：webhook 到达、订单交付、交付邮件发出",
    "测试卡 4000 0000 0000 5126：退款先成功后失败，订单转 refund_failed（refund_reversed）并出现在运营异常列表",
    "测试卡 4000 0000 0000 0259：拒付后按订单撤回访问",
    "删除报告时仍开着的 Checkout 被关闭；关闭前已付款的原路退款",
  );
} else if (service === "openai") {
  const budgetUsd = Number(opts.get("budget-usd"));
  if (!dryRun) {
    if (e.LLM_PROVIDER !== "openai" || !e.OPENAI_API_KEY) die("需要 LLM_PROVIDER=openai 与 OPENAI_API_KEY");
    if (!(budgetUsd > 0)) die("需要显式预算：--budget-usd=<美元>（三条路由一次约 US$0.1）");
  }
  const allowUnreviewed = opts.has("allow-unreviewed");
  environment = dryRun ? "fake llm (dry run)" : `openai synthetic case, budget US$${budgetUsd}${allowUnreviewed ? ", unreviewed content" : ""}`;
  const { getLlm, routeConfig } = await import("../server/llm");
  const { withBudget } = await import("../server/llm/budget");
  const run = await import("../server/eval/run");
  const llm = dryRun ? getLlm() : withBudget(getLlm(), { budgetUsd });
  const cases = run.loadCases(path.join(ROOT, "evals/cases.yaml")).filter((c) => c.id === "sample-career");
  const rows = await run.runEval({
    llm,
    cases,
    triageModel: routeConfig("triage").model,
    reportModels: [routeConfig("report").model],
    followupModels: [routeConfig("followup").model],
    effort: routeConfig("report").effort,
    reviewedOnly: !allowUnreviewed,
  });
  for (const route of ["triage", "report", "followup"] as const) {
    const r = rows.find((x) => x.route === route);
    checks.push({
      name: `${route} route (${r?.model ?? routeConfig(route).model})`,
      ok: Boolean(r?.passed),
      detail: r ? `${r.outcome} · ${r.businessAttempts} 次业务调用 · ${r.e2eMs} ms · ${r.costKnown ? `US$${r.costUsd.toFixed(4)}` : "成本未知"}` : "未运行",
    });
  }
  if (rows.some((r) => r.outcome === "review_pending")) pending.push("合成样例所需的原文、白话或主题仍待审：先完成内容审校，再按已审内容重跑");
  if (allowUnreviewed) pending.push("本次用未审内容跑通路由：只验证参数与路由，不代表上线内容的质量");
  if ("spent" in llm) {
    const s = (llm as ReturnType<typeof withBudget>).spent();
    checks.push({ name: "budget", ok: s.knownUsd <= budgetUsd && s.unknownCalls === 0, detail: `已知 US$${s.knownUsd.toFixed(4)} / 预算 US$${budgetUsd}，成本未知 ${s.unknownCalls} 次` });
  }
  pending.push("人工评审合成样例的报告与追问（npm run eval:models -- --live 生成的评审表）");
} else {
  const to = opts.get("to") ?? "delivered@resend.dev";
  if (!to.endsWith("@resend.dev") && !opts.has("confirm-test-inbox")) die(`--to=${to} 不是 Resend 的测试地址；确认它是测试收件箱后加 --confirm-test-inbox`);
  if (dryRun) die("Resend 联调没有替身模式");
  if (e.MAIL_PROVIDER !== "resend" || !e.RESEND_API_KEY) die("需要 MAIL_PROVIDER=resend 与 RESEND_API_KEY");
  environment = `resend test inbox (${to.endsWith("@resend.dev") ? to : "custom test inbox"})`;
  const key = `acceptance:${randomUUID()}`;
  const send = async () => {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${e.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ from: e.MAIL_FROM, to: [to], subject: "问山联调：幂等发送", text: "这是一封联调邮件。同一幂等键发送两次，只应收到这一封。" }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    return { status: res.status, id: body.id ?? null, message: body.message ?? "" };
  };
  const first = await send();
  const second = await send();
  checks.push({ name: "send accepted", ok: first.status === 200 && Boolean(first.id), detail: `HTTP ${first.status} ${first.message}`.trim() });
  checks.push({ name: "same idempotency key → same email", ok: Boolean(first.id) && first.id === second.id, detail: `${first.id} / ${second.id}` });
  if (first.id) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(`https://api.resend.com/emails/${first.id}`, { headers: { Authorization: `Bearer ${e.RESEND_API_KEY}` } });
    const body = (await res.json().catch(() => ({}))) as { last_event?: string };
    checks.push({ name: "delivery status", ok: res.ok && body.last_event !== "bounced", detail: `last_event=${body.last_event ?? "unknown"}` });
  }
  pending.push(
    to.endsWith("@resend.dev") ? "用自己的测试收件箱各收一次验证码、交付通知与工单通知，确认内容与链接" : "在测试收件箱确认只收到一封联调邮件",
    "MAIL_FROM 的发件域名在 Resend 已验证（SPF/DKIM）",
  );
}

const ok = checks.every((c) => c.ok);
console.log(`\n${service} 联调（${environment}）`);
for (const c of checks) console.log(`  ${c.ok ? "✓" : "×"} ${c.name}：${c.detail}`);
if (pending.length) {
  console.log("\n待核实（自动化覆盖不到）：");
  for (const p of pending) console.log(`  · ${p}`);
}

if (dryRun) {
  console.log("\n替身自检：不写联调记录。");
  process.exit(ok ? 0 : 1);
}

const git = (...a: string[]) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();
const evidencePath = path.resolve(HERE, "../acceptance/live-evidence.json");
const file: EvidenceFile = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, "utf8")) : { version: 1, entries: [] };
const entry: LiveEvidence = {
  service,
  recordedAt: new Date().toISOString(),
  commit: git("rev-parse", "HEAD"),
  dirty: git("status", "--porcelain", "--", ".", ":(exclude)apps/web/acceptance/live-evidence.json").length > 0,
  configVersion: configVersion(e, service),
  environment,
  result: ok ? "pass" : "fail",
  checks,
  pending,
};
file.entries.push(entry);
writeFileSync(evidencePath, `${JSON.stringify(file, null, 1)}\n`);
console.log(`\n已记录到 ${path.relative(process.cwd(), evidencePath)}（提交 ${entry.commit.slice(0, 8)}${entry.dirty ? "，含未提交改动" : ""}，配置版本 ${entry.configVersion}）`);
process.exit(ok ? 0 : 1);
