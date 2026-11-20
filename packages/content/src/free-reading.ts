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
  /** 缺失原文的编号；非空时不能进入付费（技术方案 5.2） */
  missingEntries: string[];
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
    topicHint: topic.free.angleHints[focusAngle] ?? topic.free.angleHints.default,
    reflectionQuestion: questions[stableIndex(`${readingId}:${focusAngle}`, questions.length)]!,
    missingEntries,
  };
}
