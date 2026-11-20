/**
 * 从内容仓库提取只在服务端使用的部分（各主题的报告要求与边界例子），
 * 写入 server/generated/report-rules.json。浏览器的内容包里不含这些字段。
 *
 *   npm run server-content -w @wenshan/web
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSources } from "@wenshan/content/node";

const src = await loadSources();
const sampleOf = (id: string) => src.samples.find((s) => s.topic === id);
const out = {
  contentVersion: src.version,
  topics: Object.fromEntries(
    src.topics.map((t) => {
      const s = sampleOf(t.id);
      return [
        t.id,
        {
          id: t.id,
          name: t.name,
          version: t.version,
          reviewStatus: t.reviewStatus,
          report: t.report,
          boundaryExamples: t.boundaryExamples,
          // 示范取自内容仓库的样例（samples/*.yaml）：完整报告样例，或同一卦在本主题下的"下一步"
          example: s ? { question: s.question, paid: s.paid ?? null, nextStep: s.nextStep ?? null } : null,
        },
      ];
    }),
  ),
};
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../server/generated/report-rules.json");
await writeFile(file, `${JSON.stringify(out, null, 1)}\n`);
console.log(`wrote ${path.relative(process.cwd(), file)}`);
