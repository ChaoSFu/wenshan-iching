/**
 * 校验内容并生成 generated/*.json。
 *
 *   npm run content:build            # 校验 + 生成
 *   npm run content:check            # 只校验，并确认 generated/ 与源文件一致（CI 用）
 *   npm run content:build -- --strict  # 上线标准：原文、白话、主题、求助资源都必须已审核
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { CONTENT_ROOT, buildBundles, loadSources, validateSources } from "../src/node";

const CHECK = process.argv.includes("--check");
const STRICT = process.argv.includes("--strict");

const src = await loadSources();
const report = validateSources(src, { strict: STRICT });

const c = report.coverage;
console.log(
  `原文 ${c.originalsPresent}/${c.required}（已审 ${c.originalsReviewed}）· 白话 ${c.vernacularPresent}/${c.required}（已审 ${c.vernacularReviewed}）`,
);
for (const w of report.warnings) console.warn(`warning: ${w}`);
for (const e of report.errors) console.error(`error: ${e}`);
if (report.errors.length) {
  console.error(`${report.errors.length} error(s)`);
  process.exit(1);
}

const bundles = buildBundles(src);
const outDir = path.join(CONTENT_ROOT, "generated");
await mkdir(outDir, { recursive: true });

let stale = false;
for (const [name, data] of Object.entries(bundles)) {
  const file = path.join(outDir, `${name}.json`);
  const json = `${JSON.stringify(data, null, 1)}\n`;
  if (CHECK) {
    const current = await readFile(file, "utf8").catch(() => "");
    if (current !== json) {
      console.error(`stale: generated/${name}.json — run npm run content:build`);
      stale = true;
    }
  } else {
    await writeFile(file, json);
    console.log(`wrote generated/${name}.json (${data.version}, ${(json.length / 1024).toFixed(1)} KB)`);
  }
}
if (stale) process.exit(1);
