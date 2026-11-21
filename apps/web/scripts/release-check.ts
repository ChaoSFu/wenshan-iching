/**
 * 发布验收：按"生产环境"规则评估给定配置与当前内容，输出可见的发布结论。
 *
 *   npm run release:check -w @wenshan/web                          # 评估当前环境变量
 *   npm run release:check -w @wenshan/web -- --env-file=.env.prod  # 先读入某个配置文件
 *   npm run release:check -w @wenshan/web -- --target=sales        # 指定发布目标（默认按 SALES_ENABLED）
 *   npm run release:check -w @wenshan/web -- --json
 *
 * 退出码：所选目标可发布为 0，否则为 1。严格审核未通过时，结论会写明"开放收款：不可发布"及原因。
 * 只输出配置项名称，不输出任何密钥的值。
 */
import { loadSources, validateSources } from "@wenshan/content/node";
import { parseEnvLenient, type Env } from "../server/env";
import { releaseStatus, type CheckLevel } from "../server/release";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const envFile = arg("env-file");
if (envFile) process.loadEnvFile(envFile);

let e: Env;
let configError: string | undefined;
try {
  e = parseEnvLenient({ ...process.env, NODE_ENV: "production" });
} catch (err) {
  configError = err instanceof Error ? err.message : String(err);
  e = parseEnvLenient({ NODE_ENV: "production" });
}
const target = (arg("target") ?? (e.SALES_ENABLED ? "sales" : "free")) as "free" | "sales";
const status = releaseStatus(e, configError);

// 严格审核的完整结果（读内容仓库源文件，与 npm run content:strict 一致），按类型汇总
const strict = validateSources(await loadSources(), { strict: true });
const groups = new Map<string, number>();
for (const err of strict.errors) {
  const kind = /original not reviewed/.test(err)
    ? "原文未审"
    : /vernacular/.test(err)
      ? "白话未审或缺失"
      : /^topic /.test(err)
        ? "主题未审"
        : /^help\.yaml/.test(err)
          ? "求助号码未核实"
          : "其他";
  groups.set(kind, (groups.get(kind) ?? 0) + 1);
}

const ready = target === "sales" ? status.salesReady : status.freeReady;

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ target, ready, ...status, strict: { errors: strict.errors.length, groups: Object.fromEntries(groups) } }, null, 2));
} else {
  const mark: Record<CheckLevel, string> = { pass: "通过", warn: "注意", fail: "阻断" };
  console.log(`问山发布验收（按生产环境规则评估${envFile ? `，配置文件 ${envFile}` : ""}）\n`);
  console.log("检查项".padEnd(8, "　"), "免费体验", "开放收款", "说明");
  for (const c of status.checks) {
    console.log(c.label.padEnd(8, "　"), mark[c.free].padEnd(6), mark[c.sales].padEnd(6), c.detail);
  }
  console.log(`\n严格审核（content:strict）：${strict.errors.length ? `${strict.errors.length} 项未通过` : "通过"}`);
  for (const [k, n] of groups) console.log(`  · ${k} ${n} 项`);
  console.log("\n发布结论");
  console.log(`  免费体验：${status.freeReady ? "可发布" : "不可发布"}`);
  console.log(`  开放收款：${status.salesReady ? "可发布" : "不可发布"}`);
  const blockers = status.checks.filter((c) => (target === "sales" ? c.sales : c.free) === "fail");
  if (blockers.length) {
    console.log(`\n本次目标（${target === "sales" ? "开放收款" : "免费体验"}）的阻断项：`);
    for (const b of blockers) console.log(`  × ${b.label}：${b.detail}`);
  }
}
process.exit(ready ? 0 : 1);
