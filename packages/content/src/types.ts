import type { TrigramId } from "@wenshan/iching-core";

export type ReviewStatus = "imported" | "draft" | "reviewed";
export type EntryKind = "gua" | "yao" | "yong" | "tuan" | "xiang" | "xiaoxiang" | "wenyan";
export type TopicId = "love" | "career" | "study" | "money" | "other";
export const TOPIC_IDS: readonly TopicId[] = ["love", "career", "study", "money", "other"];

export type AngleId =
  | "prepare"
  | "probe"
  | "persevere"
  | "restrain"
  | "wait"
  | "advance"
  | "cooperate"
  | "adjust"
  | "caution"
  | "reflect";
export type AngleKey = AngleId | "default";

// ---------- 典籍（corpus.json） ----------

export interface CorpusEntry {
  id: string;
  kind: EntryKind;
  hexagram: number;
  line?: number;
  label?: string;
  text: string;
  textTrad: string;
  reviewStatus: ReviewStatus;
}

export interface HexagramInfo {
  number: number;
  name: string;
  nameTrad: string;
  upper: TrigramId;
  lower: TrigramId;
  sourceUrl: string;
  sourcePermalink: string;
  sourceRevision: number;
}

export interface Annotation {
  entryId: string;
  vernacular: string;
  angles: AngleId[];
  reviewStatus: ReviewStatus;
}

export interface CorpusBundle {
  version: string;
  hexagrams: Record<string, HexagramInfo>;
  entries: Record<string, CorpusEntry>;
  annotations: Record<string, Annotation>;
}

// ---------- 主题、分流、求助（topics.json） ----------

export interface ContextField {
  key: string;
  label: string;
  primary?: boolean;
  placeholder?: string;
}

export interface Topic {
  id: TopicId;
  version: number;
  reviewStatus: ReviewStatus;
  order: number;
  name: string;
  tagline: string;
  intents: string[];
  examples: string[];
  clarifyHint: string;
  reframeExample: { from: string; to: string };
  contextFields: ContextField[];
  free: {
    angleHints: Record<AngleKey, string>;
    reflectionQuestions: Record<AngleKey, string[]>;
  };
}

export interface Angle {
  id: AngleId;
  name: string;
  description: string;
}

export interface TriageCategory {
  id: string;
  action: "crisis" | "notice";
  title: string;
  message: string;
  keywords: string[];
}

export interface TriageRules {
  version: number;
  categories: TriageCategory[];
  outcome: { title: string; message: string; patterns: string[] };
  multiQuestion: { title: string; message: string };
}

export interface HelpResources {
  version: number;
  needsVerification: boolean;
  intro: string;
  regions: { id: string; name: string; items: { label: string; number?: string }[] }[];
}

export interface TopicsBundle {
  version: string;
  topics: Topic[];
  angles: Angle[];
  triage: TriageRules;
  help: HelpResources;
}

// ---------- 样例（samples.json） ----------

export interface Sample {
  topic: TopicId;
  title: string;
  question: string;
  lines: (6 | 7 | 8 | 9)[];
  nextStep?: string;
  free?: { vernacular: string; reflection: string };
  paid?: {
    situation: string;
    observation: string;
    observationCitations: string[];
    toVerify: string;
    sevenDayAction: string;
    followupExample: string;
  };
}

export interface SamplesBundle {
  version: string;
  samples: Sample[];
}
