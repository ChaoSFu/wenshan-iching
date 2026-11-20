"use client";

import { CAST_RULE_VERSION, type Toss } from "@wenshan/iching-core";
import type { TopicId } from "@wenshan/content";

/**
 * 一次起卦在浏览器里的全部状态。只存在 sessionStorage（当前标签页），
 * 不上传服务器（PRD §8：免费文本和草稿默认只留在浏览器当前会话）。
 */
export interface StoredReading {
  id: string;
  question: string;
  topicId: TopicId;
  /** 用户最初选的主题，用于核对"原选入口 vs 最终主题"（PRD §10） */
  topicOriginal: TopicId;
  context: Record<string, string>;
  /** 点「开始起卦」时一次抽齐的 18 枚钱币 */
  tosses: Toss[];
  /** 已揭示的爻数 0–6；刷新后从这里继续 */
  revealed: number;
  castRuleVersion: string;
  createdAt: string;
}

export interface Draft {
  question: string;
  topicId?: TopicId;
}

const readingKey = (id: string) => `wenshan:reading:${id}`;
const DRAFT_KEY = "wenshan:draft";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function readJson<T>(key: string): T | null {
  try {
    const raw = storage()?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadReading(id: string): StoredReading | null {
  const r = readJson<StoredReading>(readingKey(id));
  return r && r.id === id && Array.isArray(r.tosses) ? r : null;
}

export function saveReading(r: StoredReading): boolean {
  return writeJson(readingKey(r.id), r);
}

export function newReading(input: {
  question: string;
  topicId: TopicId;
  context: Record<string, string>;
  tosses: Toss[];
}): StoredReading {
  return {
    id: crypto.randomUUID(),
    question: input.question,
    topicId: input.topicId,
    topicOriginal: input.topicId,
    context: input.context,
    tosses: input.tosses,
    revealed: 0,
    castRuleVersion: CAST_RULE_VERSION,
    createdAt: new Date().toISOString(),
  };
}

export function loadDraft(): Draft | null {
  return readJson<Draft>(DRAFT_KEY);
}

export function saveDraft(d: Draft): void {
  writeJson(DRAFT_KEY, d);
}

export function clearDraft(): void {
  try {
    storage()?.removeItem(DRAFT_KEY);
  } catch {
    /* 无痕模式等情况下忽略 */
  }
}

const SKIP_ANIMATION_KEY = "wenshan:skip-animation";

/** 「跳过动画」是每位访客自己的偏好，存在 localStorage。 */
export function loadSkipAnimation(): boolean {
  try {
    return window.localStorage.getItem(SKIP_ANIMATION_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveSkipAnimation(v: boolean): void {
  try {
    window.localStorage.setItem(SKIP_ANIMATION_KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}
