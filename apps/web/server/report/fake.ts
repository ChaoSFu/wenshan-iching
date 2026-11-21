import type { AllowedPassage } from "./passages";
import type { UserSituation } from "./prompt";
import type { FollowupContent, ReportContent } from "./schema";

/**
 * 本地开发用的报告替身（LLM_PROVIDER=fake）：根据输入拼出一份能通过校验的简版报告（report@2），
 * 用来走通订单、生成、回看、追问的全流程。文字明确标注为演示内容。
 * 下一步按用户给出的时间事实分三种写法（没给时间 / 给了还没到 / 已经过了），只用用户的原话，不编日期。
 */
export function fakeReport(passages: AllowedPassage[], s: UserSituation): ReportContent {
  const main = passages.filter((p) => p.role === "primary").slice(0, 2);
  const picks = main.length ? main : passages.filter((p) => p.role !== "commentary").slice(0, 1);
  const facts = Object.values(s.context).join("；");
  const overdue = /已经过了|过了约定|超过约定|逾期/.test(facts);
  const dated = !overdue && /前给答复|前回复|前答复|之前给|之前回复|给结果的时间/.test(facts);
  const next = overdue
    ? {
        trigger: "已经过了对方说的答复时间、还没收到消息时",
        action: "给面试时的联系人发一条简短跟进：确认结果是否已有安排、还需不需要补材料，同时继续投递其他机会。",
        signal: "有明确回复就按回复安排；再过几个工作日仍没有回音，就把精力转到其他机会上。",
      }
    : dated
      ? {
          trigger: "对方说的答复时间之前",
          action: "先不追问，把精力放在其他机会上；到了约定时间仍没消息，再给联系人发一条简短确认。",
          signal: "约定时间内收到答复就按答复安排；过了约定时间没有回音，就发确认消息。",
        }
      : {
          trigger: "如果对方没说过什么时候给结果",
          action: "给面试时的联系人发一条简短消息，礼貌问清大概什么时候会有结果、是否需要补充材料。",
          signal: "对方给了时间，就等到那个时间再看；没有回复时，继续留意其他机会，不把沉默当成结论。",
        };
  const first = picks[0];
  return {
    takeaway: `（演示）重点在稳住联系、看清进度：先把能确认的事问清楚，${s.topicId === "career" ? "同时不把机会押在一处。" : "再决定下一步。"}`,
    next_step: s.topicId === "career" ? next : {
      trigger: "这周找一个双方都不赶时间的时候",
      action: "先用一句话说明你想好好谈一次，再问对方方不方便，不急着在消息里把事情说完。",
      signal: "对方愿意谈就约时间；暂时不回，就给对方留出空间，过几天再看。",
    },
    basis: picks.map((p) => ({
      citation: p.id,
      text: `（演示）${p.title}${p.vernacular ? `：${p.vernacular.slice(0, 40)}` : "提供了这次的观察方向"}。`,
    })),
    artifact: {
      kind: "message",
      title: "可以直接发的消息",
      content:
        s.topicId === "career"
          ? "您好，我是【你的名字】，之前参加了【职位】的面试。想跟您确认一下后续安排，是否还需要我补充什么材料？谢谢！"
          : "【对方的称呼】，最近一直想跟你好好聊聊上次的事。你方便的时候告诉我，不急。",
    },
    followup_suggestions: [first ? "如果对方一直没有回复，下一步该怎么调整？" : "接下来先确认哪件事？"],
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
