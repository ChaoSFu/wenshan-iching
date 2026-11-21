import { YONG_JIU_ID, YONG_LIU_ID, guaId, selectPassages, tuanId, xiangId, yaoId, type Cast } from "@wenshan/iching-core";
import type { CorpusBundle, TopicId, TopicsBundle } from "./types";

/**
 * 发布审核门槛：真实收费前，本次必需的原文、实际展示和引用的白话、所用主题都必须已审核。
 * 浏览器（决定是否显示购买入口）与服务端（创建 Checkout 前）调用同一个函数。
 */

export interface PendingItem {
  kind: "original" | "vernacular" | "topic";
  id: string;
}

export interface GateResult {
  ok: boolean;
  pending: PendingItem[];
}

export function contentGate(
  cast: Pick<Cast, "primary" | "changed" | "movingLines">,
  topicId: TopicId,
  corpus: CorpusBundle,
  topics: TopicsBundle,
): GateResult {
  const pending: PendingItem[] = [];
  for (const p of selectPassages(cast)) {
    if (corpus.entries[p.entryId]?.reviewStatus !== "reviewed") pending.push({ kind: "original", id: p.entryId });
    if (corpus.annotations[p.entryId]?.reviewStatus !== "reviewed") pending.push({ kind: "vernacular", id: p.entryId });
  }
  const topic = topics.topics.find((t) => t.id === topicId);
  if (topic?.reviewStatus !== "reviewed") pending.push({ kind: "topic", id: topicId });
  return { ok: pending.length === 0, pending };
}

/** 彖传、大象等补充材料：只纳入已审核的条目（测试配置可放宽） */
export function supplementaryIds(cast: Pick<Cast, "primary" | "changed">, corpus: CorpusBundle, includeUnreviewed: boolean): string[] {
  const ids: string[] = [];
  for (const n of [cast.primary, cast.changed]) {
    if (n === null) continue;
    for (const id of [tuanId(n), xiangId(n)]) {
      const e = corpus.entries[id];
      if (e && (includeUnreviewed || e.reviewStatus === "reviewed")) ids.push(id);
    }
  }
  return ids;
}

/** 付费报告可能用到的全部原文：64 卦卦辞、384 爻辞与用九、用六 */
export function requiredEntryIds(): string[] {
  const ids: string[] = [];
  for (let n = 1; n <= 64; n++) {
    ids.push(guaId(n));
    for (let l = 1; l <= 6; l++) ids.push(yaoId(n, l));
  }
  ids.push(YONG_JIU_ID, YONG_LIU_ID);
  return ids;
}

export interface ReviewSummary {
  required: number;
  originalsReviewed: number;
  vernacularReviewed: number;
  topics: { id: TopicId; reviewStatus: string }[];
  /** 未核实的求助号码（"地区 名称 号码"） */
  helpUnverified: string[];
  /** 全部可售：所有必需原文、白话、主题都已审核 */
  allReviewed: boolean;
}

/** 内容审核进度（运营后台与 release:check 共用，读生成后的内容包） */
export function reviewSummary(corpus: CorpusBundle, topics: TopicsBundle): ReviewSummary {
  const required = requiredEntryIds();
  const originalsReviewed = required.filter((id) => corpus.entries[id]?.reviewStatus === "reviewed").length;
  const vernacularReviewed = required.filter((id) => corpus.annotations[id]?.reviewStatus === "reviewed").length;
  const topicRows = topics.topics.map((t) => ({ id: t.id, reviewStatus: t.reviewStatus }));
  const helpUnverified = topics.help.regions.flatMap((r) =>
    r.items.filter((i) => i.number && i.reviewStatus !== "reviewed").map((i) => `${r.name} ${i.label} ${i.number}`),
  );
  return {
    required: required.length,
    originalsReviewed,
    vernacularReviewed,
    topics: topicRows,
    helpUnverified,
    allReviewed:
      originalsReviewed === required.length && vernacularReviewed === required.length && topicRows.every((t) => t.reviewStatus === "reviewed"),
  };
}
