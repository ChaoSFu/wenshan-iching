import { selectPassages, tuanId, xiangId, type Cast } from "@wenshan/iching-core";
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
