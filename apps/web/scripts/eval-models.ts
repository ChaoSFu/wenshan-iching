/**
 * 模型对照评测（显式触发；默认本地替身，不花钱）：
 *   npm run eval:models -w @wenshan/web                       # 替身：验证评测流程本身
 *   npm run eval:models -w @wenshan/web -- --live             # 真实 OpenAI API（读取 .env.local 的 OPENAI_API_KEY）
 *
 * 追问盲测（同一份固定报告与历史，对比追问模型）：
 *   npm run eval:models -w @wenshan/web -- --blind-followups                     # 替身，报告在内存里冻结
 *   npm run eval:models -w @wenshan/web -- --live --blind-followups --freeze-reports   # 先用报告模型冻结真实报告
 *   npm run eval:models -w @wenshan/web -- --live --blind-followups              # 之后每次都用冻结的报告
 *
 * 可选参数：
 *   --report-models gpt-6.2-sol,gpt-6.2-astra   报告对照（第一个视为线上配置，追问基于它的报告）
 *   --followup-models gpt-6.2-sol,gpt-6.1-terra 追问对照
 *   --triage-model gpt-6.1-terra  --effort low  --cases sample-career,refer-legal
 *   --reviewed-only  只用已审核内容（与真实收款一致）
 * 结果写入 evals/results/：<时间>-<live|fake>.{json,md} 与人工评审表 <时间>-<live|fake>.review.md；
 * 盲测另写 .blind.md（只有 A/B 标签）与 .blind-key.json（标签对应的模型与汇总，评审完再打开）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const live = flag("live");

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f);
// 没有 --live 时强制用替身，即使环境里有 OPENAI_API_KEY 也不会产生费用；评测从不连数据库
process.env.LLM_PROVIDER = live ? "openai" : "fake";
delete process.env.DATABASE_URL;
process.env.RUN_MODE = "normal";
if (live && !process.env.OPENAI_API_KEY) {
  console.error("--live 需要 OPENAI_API_KEY（写在 apps/web/.env.local）");
  process.exit(1);
}

const { getLlm } = await import("../server/llm");
const run = await import("../server/eval/run");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = path.join(root, "evals/results");
mkdirSync(dir, { recursive: true });
const date = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const mode = live ? "live" : "fake";
const effort = value("effort", "low") as "low";
const reviewedOnly = flag("reviewed-only");
const reportModels = value("report-models", "gpt-6.2-sol,gpt-6.2-astra").split(",");
const followupModels = value("followup-models", "gpt-6.2-sol,gpt-6.1-terra").split(",");
const llm = getLlm();

if (flag("blind-followups")) {
  const cases = run.loadBlindCases(path.join(root, "evals/followup-blind.yaml"));
  const frozenFile = path.join(root, "evals/fixtures/blind-reports.json");
  let frozen: Awaited<ReturnType<typeof run.freezeBlindReports>>;
  if (!live || flag("freeze-reports")) {
    // 替身每次在内存里冻结；真实 API 只在显式 --freeze-reports 时生成并写入文件
    frozen = await run.freezeBlindReports({ llm, cases, model: reportModels[0]!, effort, reviewedOnly });
    if (live) {
      mkdirSync(path.dirname(frozenFile), { recursive: true });
      writeFileSync(frozenFile, `${JSON.stringify(frozen, null, 1)}\n`);
      console.log(`已冻结 ${frozen.length} 份报告：${path.relative(process.cwd(), frozenFile)}（请提交，之后的盲测都用它）`);
    }
  } else {
    if (!existsSync(frozenFile)) {
      console.error("还没有冻结的报告：先运行 --live --blind-followups --freeze-reports");
      process.exit(1);
    }
    frozen = JSON.parse(readFileSync(frozenFile, "utf8"));
    if (frozen.some((f) => f.model.startsWith("fake:"))) {
      console.error("冻结的报告来自本地替身，不能用于真实盲测；请重新 --freeze-reports");
      process.exit(1);
    }
  }
  const { items, key, caseNotes } = await run.runBlindFollowups({ llm, cases, frozen, models: followupModels, effort, reviewedOnly });
  const base = path.join(dir, `${date}-${mode}`);
  const labels = new Map(items.map((i) => [i.row, `${i.label}（${i.followup}）`]));
  const sheet = run.reviewSheet(
    items.map((i) => i.row),
    cases,
    { blindLabels: labels, caseNotes },
  );
  const summary = run.summarize(items.map((i) => i.row));
  writeFileSync(`${base}.blind.md`, `${sheet.replace("# 人工评审表", "# 追问盲测评审表（只看 A/B，不看模型）")}\n`);
  writeFileSync(`${base}.blind-key.json`, JSON.stringify({ live, date, key, frozenFrom: frozen.map((f) => ({ caseId: f.caseId, model: f.model, frozenAt: f.frozenAt })), summary }, null, 1));
  writeFileSync(`${base}.blind.json`, JSON.stringify({ live, date, items: items.map((i) => ({ ...i.row, followup: i.followup, label: i.label, model: undefined })) }, null, 1));
  console.log(`盲测完成：${items.length} 条回答`);
  console.log(`评审表：${path.relative(process.cwd(), base)}.blind.md`);
  console.log(`标签对应与汇总（评审完再打开）：${path.relative(process.cwd(), base)}.blind-key.json`);
  process.exit(0);
}

let cases = run.loadCases(path.join(root, "evals/cases.yaml"));
const only = value("cases", "");
if (only) cases = cases.filter((c) => only.split(",").includes(c.id));

const rows = await run.runEval({
  llm,
  cases,
  triageModel: value("triage-model", "gpt-6.1-terra"),
  reportModels,
  followupModels,
  effort,
  reviewedOnly,
});
const summary = run.summarize(rows);
const md = run.toMarkdown(summary, { live, date, cases: cases.length });
const base = path.join(dir, `${date}-${mode}`);
writeFileSync(`${base}.json`, JSON.stringify({ live, date, reviewedOnly, rows, summary }, null, 1));
writeFileSync(`${base}.md`, `${md}\n`);
writeFileSync(`${base}.review.md`, `${run.reviewSheet(rows, cases)}\n`);
console.log(md);
console.log(`\n明细：${path.relative(process.cwd(), base)}.json`);
console.log(`人工评审表：${path.relative(process.cwd(), base)}.review.md`);
