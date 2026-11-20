/**
 * 模型对照评测（显式触发）：
 *   npm run eval:models -w @wenshan/web                      # 本地替身，验证评测流程，不花钱
 *   npm run eval:models -w @wenshan/web -- --live            # 真实 OpenAI API（读取 .env.local 的 OPENAI_API_KEY）
 *
 * 可选参数：
 *   --report-models gpt-6.2-sol,gpt-6.2-astra   报告对照（默认 sol 与 astra）
 *   --followup-models gpt-6.2-sol,gpt-6.1-terra 追问对照（默认 sol 与 terra，比较成本）
 *   --triage-model gpt-6.1-terra                --effort low
 *   --cases sample-career,refer-legal           只跑部分用例
 * 结果写入 evals/results/<时间>-<live|fake>.{json,md}
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
// 没有 --live 时强制用替身，即使环境里有 OPENAI_API_KEY 也不会产生费用
process.env.LLM_PROVIDER = live ? "openai" : "fake";
if (live && !process.env.OPENAI_API_KEY) {
  console.error("--live 需要 OPENAI_API_KEY（写在 apps/web/.env.local）");
  process.exit(1);
}

const { getLlm } = await import("../server/llm");
const { loadCases, runEval, summarize, toMarkdown } = await import("../server/eval/run");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
let cases = loadCases(path.join(root, "evals/cases.yaml"));
const only = value("cases", "");
if (only) cases = cases.filter((c) => only.split(",").includes(c.id));

const rows = await runEval({
  llm: getLlm(),
  cases,
  triageModel: value("triage-model", "gpt-6.1-terra"),
  reportModels: value("report-models", "gpt-6.2-sol,gpt-6.2-astra").split(","),
  followupModels: value("followup-models", "gpt-6.2-sol,gpt-6.1-terra").split(","),
  effort: value("effort", "low") as "low",
});
const summary = summarize(rows);
const date = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const md = toMarkdown(summary, { live, date, cases: cases.length });
const dir = path.join(root, "evals/results");
mkdirSync(dir, { recursive: true });
const base = path.join(dir, `${date}-${live ? "live" : "fake"}`);
writeFileSync(`${base}.json`, JSON.stringify({ live, date, rows, summary }, null, 1));
writeFileSync(`${base}.md`, `${md}\n`);
console.log(md);
console.log(`\n明细：${path.relative(process.cwd(), base)}.json`);
