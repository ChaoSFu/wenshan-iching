/**
 * 从维基文库抓取《周易》64 卦原文，生成 corpus/NN.yaml。
 *
 *   npm run content:import            # 使用 .cache 中已下载的页面
 *   npm run content:import -- --refresh  # 重新下载
 *
 * - 原始 wikitext 缓存在 packages/content/.cache/wikisource/（不入库，视为不可信数据，只解析不执行）。
 * - 繁体取自 wikitext；简体通过 MediaWiki 自带的 zh-hans 转换得到（与 PRD 引用的
 *   zh.wikisource.org/zh-hans/ 页面一致），并保留 -{…}- 不转换标记的效果。
 * - 每卦记录页面修订号，作为底本快照版本（技术方案 5.2）。
 * - 导入结果的 reviewStatus 为 imported，人工对勘后改为 reviewed。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { trigramByName, hexagramByTrigrams, type TrigramId } from "@wenshan/iching-core";

const API = "https://zh.wikisource.org/w/api.php";
const USER_AGENT = "wenshan-content-importer/0.1 (non-commercial research; contact via repository)";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = path.join(ROOT, ".cache", "wikisource");
const OUT_DIR = path.join(ROOT, "corpus");
const REFRESH = process.argv.includes("--refresh");

interface ParsedPage {
  title: string;
  revid: number;
  wikitext: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 两次请求之间的最小间隔，避免触发维基文库限流 */
const REQUEST_GAP_MS = 1500;
let lastRequestAt = 0;

async function api(params: Record<string, string>, body?: Record<string, string>): Promise<unknown> {
  const url = new URL(API);
  for (const [k, v] of Object.entries({ format: "json", formatversion: "2", maxlag: "5", ...params })) {
    url.searchParams.set(k, v);
  }
  for (let attempt = 1; ; attempt++) {
    const wait = lastRequestAt + REQUEST_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: { "User-Agent": USER_AGENT, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      body: body ? new URLSearchParams(body) : undefined,
    });
    if ((res.status === 429 || res.status === 503) && attempt < 6) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000 * 2 ** (attempt - 1);
      console.warn(`  HTTP ${res.status}, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt})`);
      await sleep(delay);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const json = (await res.json()) as { error?: { code?: string; info?: string } };
    if (json.error?.code === "maxlag" && attempt < 6) {
      await sleep(5000);
      continue;
    }
    if (json.error) throw new Error(`API error: ${json.error.info ?? JSON.stringify(json.error)}`);
    return json;
  }
}

async function fetchPage(title: string, cacheName: string): Promise<ParsedPage> {
  const file = path.join(CACHE_DIR, `${cacheName}.json`);
  if (!REFRESH && existsSync(file)) return JSON.parse(await readFile(file, "utf8")) as ParsedPage;
  const json = (await api({ action: "parse", page: title, prop: "wikitext|revid" })) as {
    parse: { title: string; revid: number; wikitext: string };
  };
  const page: ParsedPage = { title: json.parse.title, revid: json.parse.revid, wikitext: json.parse.wikitext };
  await writeFile(file, JSON.stringify(page, null, 2));
  return page;
}

/** 目录页「上下經卦名次序」里的 64 个子页面名，按文王序。 */
function parseIndex(wikitext: string): string[] {
  const start = wikitext.indexOf("上下經卦名次序");
  if (start < 0) throw new Error("index section 上下經卦名次序 not found");
  const names = [...wikitext.slice(start).matchAll(/\[\[\/([^|\]]+)\|/g)].map((m) => m[1]!.trim());
  const unique = [...new Set(names)];
  if (unique.length < 64) throw new Error(`expected 64 hexagram pages, found ${unique.length}`);
  return unique.slice(0, 64);
}

// ---------- wikitext 清洗 ----------

/** 去掉模板与链接，保留 -{…}- 标记（供简体转换使用）。 */
function cleanKeepingNoConvert(s: string, warnings: string[]): string {
  let out = s
    .replace(/\{\{另\|([^|}]*)\|[^}]*\}\}/g, "$1") // {{另|磐|盤}} → 磐
    .replace(/\{\{\*\|[^}]*\}\}/g, "") // {{*|一作太和}} 小注
    .replace(/\{\{wj\}\}/g, "")
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/'''/g, "")
    .replace(/<br\s*\/?>/g, "")
    .trim();
  const leftover = out.match(/\{\{[^}]*\}\}/g);
  if (leftover) {
    warnings.push(`removed unknown templates: ${leftover.join(" ")}`);
    out = out.replace(/\{\{[^}]*\}\}/g, "");
  }
  return out;
}

const stripNoConvert = (s: string) => s.replace(/-\{([^}]*)\}-/g, "$1");

/**
 * MediaWiki 的繁简转换会把卦名「乾」误转为「干」（如履、同人的彖传「應乎乾」）。
 * 只有「噬乾胏」「噬乾肉」里的乾是"干燥"义，应转为干；其余一律恢复为乾。
 * 繁简文本逐字对齐时才处理（周易原文的转换是一字对一字）。
 */
function restoreQian(simplified: string, trad: string): string {
  const s = [...simplified];
  const t = [...trad];
  if (s.length !== t.length) return simplified;
  for (let i = 0; i < t.length; i++) {
    const dried = t[i + 1] === "胏" || t[i + 1] === "肉";
    if (t[i] === "乾" && s[i] === "干" && !dried) s[i] = "乾";
  }
  return s.join("");
}

// ---------- 单卦页面解析 ----------

type Kind = "gua" | "yao" | "yong" | "tuan" | "xiang" | "xiaoxiang" | "wenyan";

interface RawEntry {
  id: string;
  kind: Kind;
  line?: number;
  label?: string;
  /** 带 -{…}- 标记的繁体原文 */
  raw: string;
}

interface ParsedHexagram {
  number: number;
  nameRaw: string;
  upper: TrigramId;
  lower: TrigramId;
  entries: RawEntry[];
  warnings: string[];
}

// 多数页面写作「初九：」，少数（如否卦）写作「初六，」
const LABEL_RE = /^(初[六九]|[六九][二三四五]|上[六九]|用[六九])[：，:]\s*(.*)$/;
const POSITION: Record<string, number> = { 初: 1, 二: 2, 三: 3, 四: 4, 五: 5, 上: 6 };

function lineOfLabel(label: string): number | "yong" {
  if (label.startsWith("用")) return "yong";
  const pos = label.startsWith("初") || label.startsWith("上") ? label[0]! : label[1]!;
  return POSITION[pos]!;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function parseHexagram(number: number, wikitext: string): ParsedHexagram {
  const warnings: string[] = [];
  // <span …> 标签可能跨行（如坤卦），先整体去掉
  const text = wikitext.replace(/<span[^>]*>/g, "").replace(/<\/span>/g, "");
  const lines = text.split("\n").map((l) => l.trimEnd());

  const nameLine = lines.find((l) => l.startsWith(";"));
  if (!nameLine) throw new Error("hexagram name line (;名) not found");
  const nameRaw = cleanKeepingNoConvert(nameLine.slice(1), warnings);

  const comp = stripNoConvert(text).match(/(\S)下(\S)上/);
  if (!comp) throw new Error("composition X下Y上 not found");
  const lower = trigramByName(comp[1]!);
  const upper = trigramByName(comp[2]!);
  if (!lower || !upper) throw new Error(`unknown trigram in composition ${comp[0]}`);

  const id = (suffix: string) => `ZY.${pad(number)}.${suffix}`;
  const entries: RawEntry[] = [];
  let section: "none" | "jing" | "tuan" | "xiang" | "wenyan" = "none";
  let gua: string[] = [];
  let tuan: string[] = [];
  let daXiang: string | null = null;
  const xiaoXiang: string[] = [];
  const wenyan: string[] = [];
  const yaoOrder: { id: string; line: number | "yong"; label: string }[] = [];

  for (const line of lines) {
    const plain = stripNoConvert(line).replace(/'''/g, "");
    if (/^\*\s*易經：/.test(plain)) { section = "jing"; continue; }
    if (/^\*\s*彖曰：/.test(plain)) { section = "tuan"; continue; }
    if (/^\*\s*象曰：/.test(plain)) { section = "xiang"; continue; }
    if (/^\*\s*文言曰：/.test(plain)) { section = "wenyan"; continue; }
    if (section === "none" || !line.startsWith("*")) continue;

    const marker = line.match(/^[*#:]+/)![0];
    const body = cleanKeepingNoConvert(line.slice(marker.length), warnings);
    if (!body) continue;

    if (section === "jing") {
      if (marker === "**") {
        // '''-{乾}-'''：元亨。利貞。 → 去掉卦名前缀；否卦等卦名本身属于卦辞（否之匪人），不带冒号，保持原样
        gua.push(body.replace(/^(?:-\{)?[^：]{1,4}(?:\}-)?：/, ""));
      } else if (marker === "***") {
        gua.push(body);
      } else if (marker === "*#") {
        const m = stripNoConvert(body).match(LABEL_RE);
        if (!m) { warnings.push(`unrecognised line statement: ${body}`); continue; }
        const label = m[1]!;
        const pos = lineOfLabel(label);
        const entryId = pos === "yong" ? id(label === "用九" ? "Y9" : "Y6") : id(`L${pos}`);
        const raw = body.replace(/^(初[六九]|[六九][二三四五]|上[六九]|用[六九])[：，:]\s*/, "").trim();
        entries.push({ id: entryId, kind: pos === "yong" ? "yong" : "yao", line: pos === "yong" ? undefined : pos, label, raw });
        yaoOrder.push({ id: entryId, line: pos, label });
      } else {
        warnings.push(`unexpected marker ${marker} in 易經: ${body}`);
      }
    } else if (section === "tuan") {
      tuan.push(body);
    } else if (section === "xiang") {
      if (marker === "**" && daXiang === null) daXiang = body;
      else if (marker === "*#") xiaoXiang.push(body);
      else warnings.push(`unexpected marker ${marker} in 象: ${body}`);
    } else if (section === "wenyan") {
      wenyan.push(body);
    }
  }

  if (gua.length === 0) throw new Error("judgement (卦辞) not found");
  entries.unshift({ id: id("G"), kind: "gua", label: stripNoConvert(nameRaw), raw: gua.join("") });
  if (tuan.length) entries.push({ id: id("TUAN"), kind: "tuan", raw: tuan.join("") });
  if (daXiang) entries.push({ id: id("XIANG"), kind: "xiang", raw: daXiang });
  if (xiaoXiang.length === yaoOrder.length) {
    xiaoXiang.forEach((raw, i) => {
      const y = yaoOrder[i]!;
      entries.push({ id: `${y.id}.XIANG`, kind: "xiaoxiang", line: y.line === "yong" ? undefined : y.line, label: y.label, raw });
    });
  } else if (xiaoXiang.length) {
    warnings.push(`小象 count ${xiaoXiang.length} ≠ 爻 count ${yaoOrder.length}; skipped`);
  }
  if (wenyan.length) entries.push({ id: id("WY"), kind: "wenyan", raw: wenyan.join("\n") });

  const yaoCount = entries.filter((e) => e.kind === "yao").length;
  if (yaoCount !== 6) throw new Error(`expected 6 line statements, found ${yaoCount}`);
  return { number, nameRaw, upper, lower, entries, warnings };
}

// ---------- 简体转换（MediaWiki zh-hans） ----------

/** 按约 15,000 字分批转换，结果按输入内容的哈希缓存，重跑时不再请求。 */
async function toSimplifiedBatched(segments: string[]): Promise<string[]> {
  const out: string[] = [];
  let batch: string[] = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    out.push(...(await toSimplifiedCached(batch)));
    batch = [];
    size = 0;
  };
  for (const s of segments) {
    if (size + s.length > 15_000) await flush();
    batch.push(s);
    size += s.length;
  }
  await flush();
  return out;
}

async function toSimplifiedCached(segments: string[]): Promise<string[]> {
  const { createHash } = await import("node:crypto");
  const key = createHash("sha256").update(JSON.stringify(segments)).digest("hex").slice(0, 16);
  const file = path.join(CACHE_DIR, `hans-${key}.json`);
  if (!REFRESH && existsSync(file)) return JSON.parse(await readFile(file, "utf8")) as string[];
  const result = await toSimplified(segments);
  await writeFile(file, JSON.stringify(result));
  return result;
}

async function toSimplified(segments: string[]): Promise<string[]> {
  const input = segments.map((s, i) => `@@${i}@@${s.replace(/\n/g, " ⏎ ")}`).join("\n\n");
  const json = (await api(
    { action: "parse", prop: "text", contentmodel: "wikitext", variant: "zh-hans", disablelimitreport: "1" },
    { text: input },
  )) as { parse: { text: string } };
  const html = json.parse.text
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
  const parts = html.split(/@@(\d+)@@/);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i += 2) out[Number(parts[i])] = parts[i + 1]!.trim().replace(/ ⏎ /g, "\n");
  if (out.length !== segments.length || out.some((s) => s === undefined)) {
    throw new Error("simplified conversion lost segments");
  }
  return out;
}

// ---------- 主流程 ----------

async function main() {
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  const index = await fetchPage("周易", "index");
  const names = parseIndex(index.wikitext);
  console.log(`index: ${names.length} hexagrams (rev ${index.revid})`);

  // 1) 下载并解析全部页面
  let failures = 0;
  const parsedAll: { page: ParsedPage; parsed: ParsedHexagram }[] = [];
  for (const [i, pageName] of names.entries()) {
    const number = i + 1;
    try {
      const page = await fetchPage(`周易/${pageName}`, pad(number));
      const parsed = parseHexagram(number, page.wikitext);
      const expected = hexagramByTrigrams(parsed.upper, parsed.lower);
      if (expected !== number) {
        parsed.warnings.push(`composition ${parsed.lower}下${parsed.upper}上 maps to ${expected} in iching-core, page order says ${number}`);
      }
      parsedAll.push({ page, parsed });
    } catch (err) {
      failures++;
      console.error(`${pad(number)} ${pageName}: FAILED — ${(err as Error).message}`);
    }
  }

  // 2) 分批转换简体
  const segments = parsedAll.flatMap(({ parsed }) => [parsed.nameRaw, ...parsed.entries.map((e) => e.raw)]);
  const converted = await toSimplifiedBatched(segments);
  let cursor = 0;

  // 3) 写出 YAML
  for (const { page, parsed } of parsedAll) {
    const number = parsed.number;
    const simplified = converted.slice(cursor, cursor + 1 + parsed.entries.length);
    cursor += 1 + parsed.entries.length;
    {
      const doc = {
        number,
        name: simplified[0],
        nameTrad: stripNoConvert(parsed.nameRaw),
        upper: parsed.upper,
        lower: parsed.lower,
        source: {
          title: page.title,
          url: `https://zh.wikisource.org/zh-hans/${encodeURI(page.title)}`,
          revision: page.revid,
          permalink: `https://zh.wikisource.org/w/index.php?oldid=${page.revid}`,
          edition: "维基文库《周易》",
        },
        entries: parsed.entries.map((e, j) => ({
          id: e.id,
          kind: e.kind,
          ...(e.line !== undefined ? { line: e.line } : {}),
          ...(e.label ? { label: e.kind === "gua" ? simplified[0] : e.label } : {}),
          text: restoreQian(simplified[j + 1]!, stripNoConvert(e.raw)),
          textTrad: stripNoConvert(e.raw),
          reviewStatus: "imported",
        })),
      };
      const header = `# 由 scripts/import-wikisource.ts 生成；人工对勘后把 reviewStatus 改为 reviewed\n`;
      await writeFile(path.join(OUT_DIR, `${pad(number)}.yaml`), header + stringify(doc, { lineWidth: 0 }));
      const flag = parsed.warnings.length ? `  ⚠ ${parsed.warnings.join(" | ")}` : "";
      console.log(`${pad(number)} ${doc.name} (${doc.entries.length} entries)${flag}`);
    }
  }
  if (failures) {
    console.error(`${failures} hexagram(s) failed`);
    process.exitCode = 1;
  }
}

await main();
