import topicsJson from "@wenshan/content/generated/topics.json";
import samplesJson from "@wenshan/content/generated/samples.json";
import {
  TOPIC_IDS,
  type CorpusBundle,
  type SamplesBundle,
  type Topic,
  type TopicId,
  type TopicsBundle,
} from "@wenshan/content";

export const topicsBundle = topicsJson as unknown as TopicsBundle;
export const samplesBundle = samplesJson as unknown as SamplesBundle;

export const topics: Topic[] = [...topicsBundle.topics].sort((a, b) => a.order - b.order);

export function isTopicId(x: unknown): x is TopicId {
  return typeof x === "string" && (TOPIC_IDS as readonly string[]).includes(x);
}

export function topicById(id: TopicId): Topic {
  const t = topics.find((x) => x.id === id);
  if (!t) throw new Error(`unknown topic ${id}`);
  return t;
}

let corpusPromise: Promise<CorpusBundle> | null = null;

/**
 * 典籍内容包约 50 KB（gzip），起卦动画期间加载。
 * 一次加载全部 64 卦，不按卦分片，免得请求本身暴露用户得了哪一卦（技术方案 3.1）。
 */
export function loadCorpus(): Promise<CorpusBundle> {
  corpusPromise ??= import("@wenshan/content/generated/corpus.json").then((m) => m.default as unknown as CorpusBundle);
  return corpusPromise;
}

