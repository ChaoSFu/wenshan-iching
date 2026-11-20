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
