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
import { serverContentJson } from "./lib/server-content";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../server/generated/report-rules.json");
await writeFile(file, serverContentJson(await loadSources()));
console.log(`wrote ${path.relative(process.cwd(), file)}`);
