import { castFromTosses, type Cast } from "@wenshan/iching-core";
import type { TopicId } from "@wenshan/content";
import { corpus, reportRules, topicsBundle } from "./content";
import { decryptJson, encryptJson } from "./crypto";
import type { orders } from "./db/schema";
import type { ReadingPlain } from "./readings";
import { allowedPassages, type AllowedPassage } from "./report/passages";
import type { TriageOutput } from "./triage";

/**
 * 订单快照：下单时冻结用户确认的题意，报告与追问都只读快照。
 * 之后用户再改问题、主题，或内容库更新，都不影响这笔订单。
 * - intent（密文）：问题、背景、题意摘要、待补信息、改写建议
 * - basis（明文，不含个人信息）：主题与版本、卦象、获准引用的原文与版本、分流结果
 */

export interface OrderIntent {
  question: string;
  context: Record<string, string>;
  summary: string | null;
  missingInfo: string[];
  reframe: string | null;
}

export interface OrderBasis {
  v: 1;
  readingRevision: number;
  topicId: TopicId;
  topicName: string;
  topicVersion: number;
  topicReviewStatus: string;
  cast: Pick<Cast, "tosses" | "lines" | "primary" | "changed" | "movingLines" | "ruleVersion">;
  selectionVersion: string;
  corpusVersion: string;
  topicsVersion: string;
  /** reviewed：只用已审核内容；unreviewed_test：模拟流程的测试配置 */
  contentMode: "reviewed" | "unreviewed_test";
  passages: AllowedPassage[];
  triage: { id: string | null; version: string; decision: string; riskCategory: string };
  /** 由旧数据补建的快照 */
  legacy?: boolean;
}

export function buildSnapshot(
  reading: ReadingPlain,
  triage: { id: string | null; version: string; output: Pick<TriageOutput, "question_summary" | "missing_info" | "controllable_reframe" | "decision" | "risk_category"> },
  opts: { includeUnreviewed: boolean; legacy?: boolean },
): { intent: OrderIntent; basis: OrderBasis; missing: string[] } {
  const { passages, missing } = allowedPassages(reading.cast, { includeUnreviewed: opts.includeUnreviewed });
  const topic = topicsBundle.topics.find((t) => t.id === reading.topicId)!;
  return {
    intent: {
      question: reading.question,
      context: reading.context,
      summary: triage.output.question_summary ?? null,
      missingInfo: triage.output.missing_info ?? [],
      reframe: triage.output.controllable_reframe ?? null,
    },
    basis: {
      v: 1,
      readingRevision: reading.revision,
      topicId: reading.topicId,
      topicName: reportRules(reading.topicId).name,
      topicVersion: topic.version,
      topicReviewStatus: topic.reviewStatus,
      cast: {
        tosses: reading.cast.tosses,
        lines: reading.cast.lines,
        primary: reading.cast.primary,
        changed: reading.cast.changed,
        movingLines: reading.cast.movingLines,
        ruleVersion: reading.cast.ruleVersion,
      },
      selectionVersion: "select@1",
      corpusVersion: corpus.version,
      topicsVersion: topicsBundle.version,
      contentMode: opts.includeUnreviewed ? "unreviewed_test" : "reviewed",
      passages,
      triage: { id: triage.id, version: triage.version, decision: triage.output.decision, riskCategory: triage.output.risk_category },
      ...(opts.legacy ? { legacy: true } : {}),
    },
    missing,
  };
}

export function snapshotColumns(s: { intent: OrderIntent; basis: OrderBasis }) {
  return { intentCt: encryptJson(s.intent), basis: s.basis, readingRevision: s.basis.readingRevision, triageResultId: s.basis.triage.id };
}

export function readIntent(o: Pick<typeof orders.$inferSelect, "intentCt">): OrderIntent | null {
  return o.intentCt ? decryptJson<OrderIntent>(o.intentCt) : null;
}

export function readBasis(o: Pick<typeof orders.$inferSelect, "basis">): OrderBasis | null {
  const b = o.basis as OrderBasis | null;
  return b && b.v === 1 ? b : null;
}

/** 快照里的卦象还原成完整的 Cast（含校验） */
export function basisCast(b: OrderBasis): Cast {
  return castFromTosses(b.cast.tosses);
}
