import { reportRules } from "../content";
import type { AllowedPassage } from "./passages";
import type { UserSituation } from "./prompt";
import type { FollowupContent, ReportContent } from "./schema";

/**
 * 本地开发用的报告替身（LLM_PROVIDER=fake）：根据输入拼出一份能通过校验的报告，
 * 用来走通订单、生成、回看、追问的全流程。文字明确标注为演示内容。
 */
export function fakeReport(passages: AllowedPassage[], s: UserSituation): ReportContent {
  const rules = reportRules(s.topicId);
  const main = passages.filter((p) => p.role === "primary").slice(0, 2);
  const picks = main.length ? main : passages.slice(0, 1);
  const contextText = Object.values(s.context).join("；");
  return {
    question_summary: (s.summary ?? `你想弄清：${s.question}`).slice(0, 80),
    situation: `（演示内容）你关心的是：${s.question.slice(0, 60)}${contextText ? `。你补充了：${contextText.slice(0, 80)}` : ""}。目前最需要先弄清的，是哪些事实已经确定、哪些还只是猜测。`,
    observations: picks.map((p) => ({
      angle: (p.angleName ?? "先看清处境").slice(0, 16),
      text: `${p.title}提供了一个观察角度。${p.vernacular ? p.vernacular.slice(0, 80) : "可以先从原文的意象出发，想一想它和你眼下处境的对应之处。"}放在你的问题里，可以先从一件能核实的小事做起。`,
      citations: [p.id],
    })),
    to_verify: rules.report.mustVerify.slice(0, 3).map((item) => ({
      item: item.slice(0, 80),
      how: "先写下你已经知道的和不确定的部分，再找一位了解情况的人问一问。",
    })),
    seven_day_action: {
      what: `用一个小时，把和${rules.report.mustVerify[0] ?? "这件事"}有关的已知信息写下来，并选出一件本周就能核实的事去做。`,
      by_when: "第 7 天前",
      feedback_signal: "完成后，看看新信息是让判断更清楚，还是带出了新的疑问。",
    },
    review_condition: "七天后回看：这一步是否完成、带来了什么新信息；情况有明显变化时也可以回来重新看。",
    followup_suggestions: ["如果核实后发现情况和预想不同，下一步该怎么调整？"],
  };
}

export function fakeFollowup(question: string): FollowupContent {
  const different = /另外一件事|换个问题|顺便问/.test(question);
  return different
    ? { is_same_matter: false, answer: "这个问题看起来是另一件事。为了让卦象对应清楚，建议为它重新起一卦。", adjusted_action: null, citations: [] }
    : {
        is_same_matter: true,
        answer: `（演示内容）结合你补充的情况，可以先把报告里的七天行动缩小一步：只做其中最容易开始的部分，再根据得到的反馈决定是否继续。`,
        adjusted_action: null,
        citations: [],
      };
}
