/**
 * 仅在 Node 中使用：读取内容仓库里的 YAML，校验并生成前端用的 JSON 内容包。
 * 浏览器代码请从 "@wenshan/content" 导入类型与纯函数。
 */
import { requiredEntryIds } from "./gate";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { TRIGRAM_IDS, bitsOfHexagram, hexagramByTrigrams } from "@wenshan/iching-core";
import {
  TOPIC_IDS,
  type AngleId,
  type CorpusBundle,
  type SamplesBundle,
  type TopicsBundle,
} from "./types";

export const CONTENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------- 源文件 schema ----------

const reviewStatus = z.enum(["imported", "draft", "reviewed"]);
const trigramId = z.enum(TRIGRAM_IDS as [string, ...string[]]);
const angleIds = ["prepare", "probe", "persevere", "restrain", "wait", "advance", "cooperate", "adjust", "caution", "reflect"] as const;
const angleId = z.enum(angleIds);
const angleKeys = [...angleIds, "default"] as const;

const corpusFileSchema = z.strictObject({
  number: z.number().int().min(1).max(64),
  name: z.string().min(1),
  nameTrad: z.string().min(1),
  upper: trigramId,
  lower: trigramId,
  source: z.strictObject({
    title: z.string(),
    url: z.string().url(),
    revision: z.number().int(),
    permalink: z.string().url(),
    edition: z.string(),
  }),
  entries: z.array(
    z.strictObject({
      id: z.string().regex(/^ZY\.\d{2}\.[A-Z0-9.]+$/),
      kind: z.enum(["gua", "yao", "yong", "tuan", "xiang", "xiaoxiang", "wenyan"]),
      line: z.number().int().min(1).max(6).optional(),
      label: z.string().optional(),
      text: z.string().min(1),
      textTrad: z.string().min(1),
      reviewStatus,
    }),
  ),
});
export type CorpusFile = z.infer<typeof corpusFileSchema>;

const annotationFileSchema = z.strictObject({
  hexagram: z.number().int().min(1).max(64),
  entries: z.array(
    z.strictObject({
      entryId: z.string(),
      vernacular: z.string().min(1),
      angles: z.array(angleId).min(1).max(2),
      authorship: z.enum(["self", "licensed"]),
      reviewStatus,
    }),
  ),
});

const angleMap = <T extends z.ZodType>(v: T) =>
  z.strictObject(Object.fromEntries(angleKeys.map((k) => [k, v])) as Record<(typeof angleKeys)[number], T>);

const topicFileSchema = z.strictObject({
  id: z.enum(TOPIC_IDS as [string, ...string[]]),
  version: z.number().int(),
  reviewStatus,
  order: z.number().int(),
  name: z.string(),
  tagline: z.string(),
  intents: z.array(z.string()).min(1),
  examples: z.array(z.string()).length(3),
  clarifyHint: z.string(),
  reframeExample: z.strictObject({ from: z.string(), to: z.string() }),
  contextFields: z
    .array(
      z.strictObject({
        key: z.string().regex(/^[a-zA-Z]+$/),
        label: z.string(),
        primary: z.boolean().optional(),
        placeholder: z.string().optional(),
      }),
    )
    .max(3),
  free: z.strictObject({
    angleHints: angleMap(z.string().min(1)),
    reflectionQuestions: angleMap(z.array(z.string().min(1)).min(1)),
  }),
  report: z.strictObject({
    mustVerify: z.array(z.string()).min(1),
    deliverables: z.array(z.string()).min(1),
    actionStyle: z.string(),
  }),
  boundaryExamples: z.array(z.strictObject({ q: z.string(), note: z.string() })),
});
export type TopicFile = z.infer<typeof topicFileSchema>;

const anglesFileSchema = z.strictObject({
  version: z.number().int(),
  reviewStatus,
  angles: z.array(z.strictObject({ id: angleId, name: z.string(), description: z.string() })),
});

const triageFileSchema = z.strictObject({
  version: z.number().int(),
  reviewStatus,
  categories: z.array(
    z.strictObject({
      id: z.string(),
      action: z.enum(["crisis", "notice"]),
      title: z.string(),
      message: z.string(),
      keywords: z.array(z.string().min(1)).min(1),
    }),
  ),
  outcome: z.strictObject({ title: z.string(), message: z.string(), patterns: z.array(z.string()).min(1) }),
  multiQuestion: z.strictObject({ title: z.string(), message: z.string() }),
});

const helpItemSchema = z
  .strictObject({
    label: z.string(),
    number: z.string().optional(),
    reviewStatus: z.enum(["draft", "reviewed"]).default("draft"),
    source: z.url().optional(),
    verifiedAt: z.iso.date().optional(),
  })
  .refine((i) => i.reviewStatus !== "reviewed" || (i.source && i.verifiedAt), {
    message: "reviewed help items need source and verifiedAt",
  });

const helpFileSchema = z.strictObject({
  version: z.number().int(),
  intro: z.string(),
  regions: z.array(z.strictObject({ id: z.string(), name: z.string(), items: z.array(helpItemSchema).min(1) })),
});

const lineValue = z.union([z.literal(6), z.literal(7), z.literal(8), z.literal(9)]);
const sampleFileSchema = z.strictObject({
  topic: z.enum(TOPIC_IDS as [string, ...string[]]),
  title: z.string(),
  question: z.string(),
  lines: z.array(lineValue).length(6),
  nextStep: z.string().optional(),
  free: z.strictObject({ vernacular: z.string(), reflection: z.string() }).optional(),
  paid: z
    .strictObject({
      situation: z.string(),
      observation: z.string(),
      observationCitations: z.array(z.string()),
      toVerify: z.string(),
      sevenDayAction: z.string(),
      followupExample: z.string(),
    })
    .optional(),
});

// ---------- 读取 ----------

async function readYaml<T extends z.ZodType>(file: string, schema: T): Promise<z.infer<T>> {
  const raw = parse(await readFile(file, "utf8")) as unknown;
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`${path.relative(CONTENT_ROOT, file)}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

async function yamlFiles(dir: string): Promise<string[]> {
  const names = await readdir(path.join(CONTENT_ROOT, dir)).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith(".yaml")).sort().map((n) => path.join(CONTENT_ROOT, dir, n));
}

export interface ContentSources {
  version: string;
  corpus: CorpusFile[];
  annotations: z.infer<typeof annotationFileSchema>[];
  topics: TopicFile[];
  angles: z.infer<typeof anglesFileSchema>;
  triage: z.infer<typeof triageFileSchema>;
  help: z.infer<typeof helpFileSchema>;
  samples: z.infer<typeof sampleFileSchema>[];
}

export async function loadSources(): Promise<ContentSources> {
  const version = (await readFile(path.join(CONTENT_ROOT, "VERSION"), "utf8")).trim();
  const corpus = await Promise.all((await yamlFiles("corpus")).map((f) => readYaml(f, corpusFileSchema)));
  const annotations = await Promise.all((await yamlFiles("annotations")).map((f) => readYaml(f, annotationFileSchema)));
  const topics = await Promise.all((await yamlFiles("topics")).map((f) => readYaml(f, topicFileSchema)));
  const samples = await Promise.all((await yamlFiles("samples")).map((f) => readYaml(f, sampleFileSchema)));
  return {
    version,
    corpus: corpus.sort((a, b) => a.number - b.number),
    annotations,
    topics: topics.sort((a, b) => a.order - b.order),
    angles: await readYaml(path.join(CONTENT_ROOT, "angles.yaml"), anglesFileSchema),
    triage: await readYaml(path.join(CONTENT_ROOT, "triage.yaml"), triageFileSchema),
    help: await readYaml(path.join(CONTENT_ROOT, "help.yaml"), helpFileSchema),
    samples,
  };
}

// ---------- 校验 ----------

/** 选文规则可能用到的全部原文：64 卦辞 + 384 爻辞 + 用九 + 用六 = 450 条 */
export interface ValidationReport {
  errors: string[];
  warnings: string[];
  coverage: {
    required: number;
    originalsPresent: number;
    originalsReviewed: number;
    vernacularPresent: number;
    vernacularReviewed: number;
  };
}

export function validateSources(src: ContentSources, opts: { strict?: boolean } = {}): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 典籍：64 卦齐全；上下卦组成与 iching-core 的卦表一致；爻题阴阳与卦画一致
  if (src.corpus.length !== 64) errors.push(`corpus has ${src.corpus.length} hexagrams, expected 64`);
  const entries = new Map<string, CorpusFile["entries"][number]>();
  for (const h of src.corpus) {
    const n = hexagramByTrigrams(h.upper as never, h.lower as never);
    if (n !== h.number) errors.push(`${h.number} ${h.name}: ${h.lower}下${h.upper}上 is hexagram ${n} in iching-core`);
    const bits = bitsOfHexagram(h.number);
    for (const e of h.entries) {
      if (entries.has(e.id)) errors.push(`duplicate entry id ${e.id}`);
      entries.set(e.id, e);
      if (!e.id.startsWith(`ZY.${String(h.number).padStart(2, "0")}.`)) errors.push(`${e.id} filed under hexagram ${h.number}`);
      if (e.kind === "yao" && e.line && e.label) {
        const yang = e.label.includes("九");
        if (yang !== (bits[e.line - 1] === 1)) {
          errors.push(`${e.id} label ${e.label} disagrees with the hexagram's line ${e.line}`);
        }
      }
    }
  }

  const required = requiredEntryIds();
  let originalsPresent = 0;
  let originalsReviewed = 0;
  for (const id of required) {
    const e = entries.get(id);
    if (!e) errors.push(`missing required original ${id}`);
    else {
      originalsPresent++;
      if (e.reviewStatus === "reviewed") originalsReviewed++;
      else if (opts.strict) errors.push(`${id} original not reviewed (${e.reviewStatus})`);
    }
  }

  // 注释：只能挂在已存在的原文上
  const annotated = new Map<string, string>();
  for (const file of src.annotations) {
    for (const a of file.entries) {
      if (!entries.has(a.entryId)) errors.push(`annotation for unknown entry ${a.entryId}`);
      if (annotated.has(a.entryId)) errors.push(`duplicate annotation for ${a.entryId}`);
      annotated.set(a.entryId, a.reviewStatus);
    }
  }
  let vernacularPresent = 0;
  let vernacularReviewed = 0;
  for (const id of required) {
    const status = annotated.get(id);
    if (status) vernacularPresent++;
    if (status === "reviewed") vernacularReviewed++;
    else if (opts.strict) errors.push(`${id} vernacular ${status ? "not reviewed" : "missing"}`);
  }

  // 主题
  const topicIds = src.topics.map((t) => t.id);
  for (const id of TOPIC_IDS) if (!topicIds.includes(id)) errors.push(`missing topic ${id}`);
  for (const t of src.topics) {
    const primaries = t.contextFields.filter((f) => f.primary).length;
    if (primaries !== 1) errors.push(`topic ${t.id} must mark exactly one primary context field (has ${primaries})`);
    if (t.reviewStatus !== "reviewed") (opts.strict ? errors : warnings).push(`topic ${t.id} is ${t.reviewStatus}`);
  }
  const angleSet = new Set(src.angles.angles.map((a) => a.id));
  for (const id of angleIds) if (!angleSet.has(id)) errors.push(`angles.yaml missing ${id}`);

  // 样例引用的原文必须存在
  for (const s of src.samples) {
    for (const id of s.paid?.observationCitations ?? []) {
      if (!entries.has(id)) errors.push(`sample ${s.topic} cites unknown entry ${id}`);
    }
  }

  // 求助号码逐条核实；未核实的在正式环境不展示
  const unverified = src.help.regions.flatMap((r) =>
    r.items.filter((i) => i.number && i.reviewStatus !== "reviewed").map((i) => `${r.name} ${i.label} ${i.number}`),
  );
  if (opts.strict) for (const u of unverified) errors.push(`help.yaml: ${u} not verified`);
  else if (unverified.length) warnings.push(`help.yaml: ${unverified.length} hotline number(s) not verified (hidden in production)`);

  return {
    errors,
    warnings,
    coverage: { required: required.length, originalsPresent, originalsReviewed, vernacularPresent, vernacularReviewed },
  };
}

// ---------- 生成内容包 ----------

const CLIENT_KINDS = new Set(["gua", "yao", "yong", "tuan", "xiang"]);

function withVersion<T extends object>(base: string, data: T): T & { version: string } {
  const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 8);
  return { version: `${base}+${hash}`, ...data };
}

export function buildBundles(src: ContentSources): {
  corpus: CorpusBundle;
  topics: TopicsBundle;
  samples: SamplesBundle;
} {
  const hexagrams: CorpusBundle["hexagrams"] = {};
  const entries: CorpusBundle["entries"] = {};
  for (const h of src.corpus) {
    hexagrams[String(h.number)] = {
      number: h.number,
      name: h.name,
      nameTrad: h.nameTrad,
      upper: h.upper as CorpusBundle["hexagrams"][string]["upper"],
      lower: h.lower as CorpusBundle["hexagrams"][string]["lower"],
      sourceUrl: h.source.url,
      sourcePermalink: h.source.permalink,
      sourceRevision: h.source.revision,
    };
    for (const e of h.entries) {
      if (!CLIENT_KINDS.has(e.kind)) continue;
      entries[e.id] = { ...e, hexagram: h.number };
    }
  }
  const annotations: CorpusBundle["annotations"] = {};
  for (const file of src.annotations) {
    for (const a of file.entries) {
      annotations[a.entryId] = {
        entryId: a.entryId,
        vernacular: a.vernacular,
        angles: a.angles as AngleId[],
        reviewStatus: a.reviewStatus,
      };
    }
  }

  const topics = src.topics.map(({ report: _report, boundaryExamples: _b, ...ui }) => ui) as TopicsBundle["topics"];

  return {
    corpus: withVersion(src.version, { hexagrams, entries, annotations }),
    topics: withVersion(src.version, {
      topics,
      angles: src.angles.angles as TopicsBundle["angles"],
      triage: src.triage as TopicsBundle["triage"],
      help: src.help,
    }),
    samples: withVersion(src.version, { samples: src.samples as SamplesBundle["samples"] }),
  };
}

export { requiredEntryIds };
