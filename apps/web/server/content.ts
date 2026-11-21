import corpusJson from "@wenshan/content/generated/corpus.json";
import topicsJson from "@wenshan/content/generated/topics.json";
import { TOPIC_IDS, type CorpusBundle, type TopicId, type TopicsBundle } from "@wenshan/content";
import rulesJson from "./generated/report-rules.json";

export const corpus = corpusJson as unknown as CorpusBundle;
export const topicsBundle = topicsJson as unknown as TopicsBundle;

export interface TopicReportRules {
  id: TopicId;
  name: string;
  version: number;
  report: { mustVerify: string[]; deliverables: string[]; actionStyle: string };
  boundaryExamples: { q: string; note: string }[];
  reviewStatus: string;
  example: {
    question: string;
    paid: { situation: string; observation: string; toVerify: string; sevenDayAction: string; followupExample: string } | null;
    nextStep: string | null;
    /** 简版报告样例（report@2 的示范） */
    concise: {
      takeaway: string;
      basis: { citation: string; text: string }[];
      nextStep: { trigger: string; action: string; signal: string };
      artifact: { kind: string; title: string; content: string } | null;
    } | null;
  } | null;
}

const rules = rulesJson as unknown as { contentVersion: string; topics: Record<string, TopicReportRules> };

export function reportRules(topic: TopicId): TopicReportRules {
  const r = rules.topics[topic];
  if (!r) throw new Error(`no report rules for topic ${topic}`);
  return r;
}

export function isTopicId(x: unknown): x is TopicId {
  return typeof x === "string" && (TOPIC_IDS as readonly string[]).includes(x);
}
