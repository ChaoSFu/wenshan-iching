import type { Topic, TriageRules } from "./types";

export interface TriageNotice {
  id: string;
  action: "crisis" | "notice";
  title: string;
  message: string;
  /** 建议的改写（仅"结果型问题"提示时提供） */
  suggestion?: { from: string; to: string };
}

export interface LocalTriageResult {
  /** 命中"即时人身安全"，暂停解读 */
  crisis: boolean;
  notices: TriageNotice[];
}

/** 去掉空白和常见标点，降低用空格、符号绕过词表的可能。 */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[\s　，。、；：！？,.;:!?“”"'‘’（）()【】\[\]…—\-·]/g, "");
}

function countQuestions(text: string): number {
  return (text.match(/[?？]/g) ?? []).length;
}

/**
 * 免费阶段的本地分流（技术方案 5.6 L0）：只在浏览器里比对，文本不离开设备。
 * 词表命中只用于提示；除"即时人身安全"外，用户都可以按原问法继续。
 */
export function runLocalTriage(question: string, rules: TriageRules, topic?: Topic): LocalTriageResult {
  const text = normalise(question);
  const notices: TriageNotice[] = [];

  for (const c of rules.categories) {
    if (c.keywords.some((k) => text.includes(normalise(k)))) {
      notices.push({ id: c.id, action: c.action, title: c.title, message: c.message });
    }
  }
  const crisis = notices.some((n) => n.action === "crisis");
  if (crisis) {
    return { crisis, notices: notices.filter((n) => n.action === "crisis") };
  }

  if (rules.outcome.patterns.some((p) => text.includes(normalise(p)))) {
    notices.push({
      id: "outcome",
      action: "notice",
      title: rules.outcome.title,
      message: rules.outcome.message,
      suggestion: topic?.reframeExample,
    });
  }
  if (countQuestions(question) >= 2) {
    notices.push({ id: "multi", action: "notice", ...rules.multiQuestion });
  }
  return { crisis, notices };
}
