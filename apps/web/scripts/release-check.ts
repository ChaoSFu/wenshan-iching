/**
 * 发布验收：按"生产环境"规则评估给定配置、内容源文件与真实联调记录，输出三项结果（配置校验、内容审校、真实联调）
 * 与两个发布目标的结论。
 *
 *   npm run release:check                                  # 评估当前环境变量，目标按 SALES_ENABLED
 *   npm run release:check -- --env-file=.env.production    # 先读入某个配置文件
 *   npm run release:check -- --target=sales                # 指定目标：free | sales（其他值直接报错）
 *   npm run release:check -- --smoke-url=https://example.com   # 顺带对部署地址做免费体验冒烟检查
 *   npm run release:check -- --json
 *
 * 退出码：所选目标可发布为 0，不可发布为 1，参数错误为 2。只输出配置项名称，不输出任何密钥的值。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSources, staleBundles, validateSources } from "@wenshan/content/node";
import type { EvidenceFile } from "../server/acceptance";
import { parseEnvLenient, type Env } from "../server/env";
import { RELEASE_TARGETS, SECTION_LABEL, releaseStatus, smokeCheck, type CheckLevel, type ReleaseTarget, type Section } from "../server/release";
import { serverContentJson } from "./lib/server-content";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALLOWED = new Set(["env-file", "target", "smoke-url", "json"]);

function fail(msg: string): never {
  console.error(`release:check: ${msg}`);
  process.exit(2);
}

const opts = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
  if (!m || !ALLOWED.has(m[1]!)) fail(`未知参数 ${a}（可用：--env-file= --target=free|sales --smoke-url= --json）`);
  opts.set(m[1]!, m[2] ?? "true");
}
const envFile = opts.get("env-file");
if (envFile) {
  if (!existsSync(envFile)) fail(`找不到配置文件 ${envFile}`);
  process.loadEnvFile(envFile);
}
const targetArg = opts.get("target");
if (targetArg !== undefined && !(RELEASE_TARGETS as readonly string[]).includes(targetArg)) fail(`--target 只能是 free 或 sales，收到 "${targetArg}"`);

let e: Env;
let configError: string | undefined;
try {
  e = parseEnvLenient({ ...process.env, NODE_ENV: "production" });
} catch (err) {
  configError = err instanceof Error ? err.message : String(err);
  e = parseEnvLenient({ NODE_ENV: "production" });
}
const target = (targetArg ?? (e.SALES_ENABLED ? "sales" : "free")) as ReleaseTarget;

// 内容源文件：结构校验、严格审校（与 npm run content:strict 一致）、生成文件与源文件是否一致
const src = await loadSources();
const basic = validateSources(src);
const strict = validateSources(src, { strict: true });
const stale = await staleBundles(src);
const serverRules = path.resolve(HERE, "../server/generated/report-rules.json");
if ((existsSync(serverRules) ? readFileSync(serverRules, "utf8") : "") !== serverContentJson(src)) stale.push("apps/web/server/generated/report-rules.json");

const evidencePath = path.resolve(HERE, "../acceptance/live-evidence.json");
const evidence = existsSync(evidencePath) ? (JSON.parse(readFileSync(evidencePath, "utf8")) as EvidenceFile).entries : [];
const smokeUrl = opts.get("smoke-url");
const smoke = smokeUrl ? await smokeCheck(smokeUrl, target) : null;

const status = releaseStatus(e, {
  configError,
  sources: { basicErrors: basic.errors, strictErrors: strict.errors, stale },
  evidence,
  smoke,
});

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

if (opts.has("json")) {
  console.log(JSON.stringify({ target, ready, ...status, strict: { errors: strict.errors.length, groups: Object.fromEntries(groups) } }, null, 2));
} else {
  const mark: Record<CheckLevel, string> = { pass: "通过", warn: "注意", fail: "阻断", na: "不适用" };
  console.log(`问山发布验收（按生产环境规则评估${envFile ? `，配置文件 ${envFile}` : ""}；配置版本 ${status.configVersion}）`);
  for (const s of ["config", "content", "live"] as Section[]) {
    const sec = status.sections[s];
    console.log(`\n【${SECTION_LABEL[s]}】免费体验：${mark[sec.free]} · 开放收款：${mark[sec.sales]}`);
    for (const c of status.checks.filter((x) => x.section === s)) {
      console.log(`  ${c.label.padEnd(12, "　")} ${mark[c.free].padEnd(4, "　")} ${mark[c.sales].padEnd(4, "　")} ${c.detail}`);
    }
    if (s === "content" && groups.size) for (const [k, n] of groups) console.log(`    · 严格审校：${k} ${n} 项`);
  }
  console.log("\n发布结论");
  console.log(`  免费体验：${status.freeReady ? "可发布" : "不可发布"}`);
  console.log(`  开放收款：${status.salesReady ? "可发布" : "不可发布"}`);
  const blockers = status.checks.filter((c) => (target === "sales" ? c.sales : c.free) === "fail");
  if (blockers.length) {
    console.log(`\n本次目标（${target === "sales" ? "开放收款" : "免费体验"}）的阻断项：`);
    for (const b of blockers) console.log(`  × [${SECTION_LABEL[b.section]}] ${b.label}：${b.detail}`);
  }
}
process.exit(ready ? 0 : 1);
