import {
  type Cast,
  type PassageRole,
  TRIGRAMS,
  bitsOfHexagram,
  focusEntryId,
  hexagramSymbol,
  selectPassages,
  SELECTION_RULE_VERSION,
} from "@wenshan/iching-core";
import type { AngleKey, CorpusBundle, ReviewStatus, Topic, TopicId, TopicsBundle } from "./types";

export interface HexagramView {
  number: number;
  name: string;
  symbol: string;
  /** 例：天风姤 → upperImage 天，lowerImage 风 */
  upperName: string;
  upperImage: string;
  lowerName: string;
  lowerImage: string;
  /** 从初爻到上爻 */
  bits: (0 | 1)[];
  sourceUrl: string;
  sourcePermalink: string;
}

export interface PassageView {
  entryId: string;
  role: PassageRole;
  from: "primary" | "changed";
  /** 例：「乾」卦辞、初九、用九 */
  title: string;
  hexagramName: string;
  text: string;
  textTrad: string;
  originalStatus: ReviewStatus;
  vernacular: string | null;
  vernacularStatus: ReviewStatus | null;
}

/**
 * 免费页的"卦意"：一句有原文依据的主旨（第四轮）。取本次重点原文（focusEntryId），
 * 原文只截取第一句，白话取落到处境上的那一句（优先"比喻/意思是/提醒……"），合起来不超过两句。
 */
export interface FreeGist {
  entryId: string;
  title: string;
  /** 原文的第一句（去掉句末标点），用「」引出 */
  quote: string;
  /** 白话里落到处境上的那一句；没有白话注释时为空 */
  meaning: string | null;
  /** 白话还是初稿（页面上标注） */
  draft: boolean;
}

export interface FreeReading {
  selectionVersion: string;
  corpusVersion: string;
  topicsVersion: string;
  primary: HexagramView;
  changed: HexagramView | null;
  movingLines: number[];
  passages: PassageView[];
  focusAngle: AngleKey;
  focusAngleName: string | null;
  topicHint: string;
  reflectionQuestion: string;
  /** 免费页首屏的一句卦意 */
  gist: FreeGist;
  /** 首屏唯一的提示：主题按观察角度的提示（原来的提示与反思问题收敛成这一条） */
  hint: string;
  /** 缺失原文的编号；非空时不能进入付费（技术方案 5.2） */
  missingEntries: string[];
}

const SENTENCE = /[^。！？]+[。！？]?/g;

/** 原文第一句；太长时按逗号截到 24 字以内（只截取，不改字） */
function firstClause(text: string): string {
  const first = (text.match(SENTENCE)?.[0] ?? text).replace(/[。！？；，、\s]+$/u, "");
  if (first.length <= 24) return first;
  let out = "";
  for (const part of first.split(/(?<=[，；])/)) {
    if ((out + part).length > 24) break;
    out += part;
  }
  return (out || first.slice(0, 24)).replace(/[，；]+$/u, "");
}

/** 白话里落到处境上的那一句：优先"比喻/意思是/提醒/说明"，否则第一句；去掉引导词 */
function applied(vernacular: string): string {
  const sentences = (vernacular.match(SENTENCE) ?? [vernacular]).map((x) => x.trim()).filter(Boolean);
  const pick = sentences.find((x) => /^(比喻|意思是|这是说|是说|提醒|说明|放在)/.test(x)) ?? sentences[0] ?? vernacular;
  const stripped = pick.replace(/^(比喻|意思是|这是说|是说|说明)[，：:]?/, "");
  return stripped.length > 60 ? `${stripped.slice(0, 58)}……` : stripped;
}

export function composeGist(cast: Pick<Cast, "primary" | "changed" | "movingLines">, corpus: CorpusBundle): FreeGist {
  // 与选文规则一致：取第一条"本次重点"（例如六爻全动的乾坤用「用九/用六」），没有时退回第一个动爻或卦辞
  const id = selectPassages(cast).find((p) => p.role === "primary")?.entryId ?? focusEntryId(cast);
  const entry = corpus.entries[id];
  const hex = corpus.hexagrams[String(cast.primary)];
  const ann = corpus.annotations[id];
  return {
    entryId: id,
    title: entry ? (entry.kind === "gua" ? `「${hex?.name ?? ""}」卦辞` : `「${hex?.name ?? ""}」${entry.label ?? ""}`) : id,
    quote: entry ? firstClause(entry.text) : "",
    meaning: ann?.vernacular ? applied(ann.vernacular) : null,
    draft: ann?.reviewStatus !== "reviewed",
  };
}

/** FNV-1a，用于按 readingId 稳定地挑选文案，刷新后不变。 */
function stableIndex(seed: string, length: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % length;
}

export function hexagramView(corpus: CorpusBundle, n: number): HexagramView {
  const info = corpus.hexagrams[String(n)];
  if (!info) throw new Error(`hexagram ${n} missing from corpus ${corpus.version}`);
  const upper = TRIGRAMS[info.upper];
  const lower = TRIGRAMS[info.lower];
  return {
    number: n,
    name: info.name,
    symbol: hexagramSymbol(n),
    upperName: upper.name,
    upperImage: upper.image,
    lowerName: lower.name,
    lowerImage: lower.image,
    bits: bitsOfHexagram(n),
    sourceUrl: info.sourceUrl,
    sourcePermalink: info.sourcePermalink,
  };
}

export function findTopic(topics: TopicsBundle, id: TopicId): Topic {
  const t = topics.topics.find((x) => x.id === id);
  if (!t) throw new Error(`unknown topic ${id}`);
  return t;
}

/**
 * 组装免费结果（技术方案 5.5）：选文 + 已审白话 + 一条主题提示 + 一个反思问题。
 * 纯函数，不调用模型，问题文本不参与计算。
 */
export function composeFreeReading(
  input: { cast: Pick<Cast, "primary" | "changed" | "movingLines">; topicId: TopicId; readingId: string },
  corpus: CorpusBundle,
  topics: TopicsBundle,
): FreeReading {
  const { cast, topicId, readingId } = input;
  const topic = findTopic(topics, topicId);
  const primary = hexagramView(corpus, cast.primary);
  const changed = cast.changed === null ? null : hexagramView(corpus, cast.changed);

  const missingEntries: string[] = [];
  const passages: PassageView[] = [];
  for (const p of selectPassages(cast)) {
    const entry = corpus.entries[p.entryId];
    if (!entry) {
      missingEntries.push(p.entryId);
      continue;
    }
    const hex = p.from === "changed" ? changed! : primary;
    const ann = corpus.annotations[p.entryId];
    passages.push({
      entryId: p.entryId,
      role: p.role,
      from: p.from,
      title: entry.kind === "gua" ? `「${hex.name}」卦辞` : (entry.label ?? p.entryId),
      hexagramName: hex.name,
      text: entry.text,
      textTrad: entry.textTrad,
      originalStatus: entry.reviewStatus,
      vernacular: ann?.vernacular ?? null,
      vernacularStatus: ann?.reviewStatus ?? null,
    });
  }

  const focus = corpus.annotations[focusEntryId(cast)];
  const focusAngle: AngleKey = focus?.angles[0] ?? "default";
  const angleName = topics.angles.find((a) => a.id === focusAngle)?.name ?? null;
  const questions = topic.free.reflectionQuestions[focusAngle] ?? topic.free.reflectionQuestions.default;

  const hint = topic.free.angleHints[focusAngle] ?? topic.free.angleHints.default;
  return {
    selectionVersion: SELECTION_RULE_VERSION,
    corpusVersion: corpus.version,
    topicsVersion: topics.version,
    primary,
    changed,
    movingLines: [...cast.movingLines],
    passages,
    focusAngle,
    focusAngleName: angleName,
    topicHint: hint,
    reflectionQuestion: questions[stableIndex(`${readingId}:${focusAngle}`, questions.length)]!,
    gist: composeGist(cast, corpus),
    hint,
    missingEntries,
  };
}
