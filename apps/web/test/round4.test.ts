/**
 * 第四轮验收（技术方案附录 G）：免费结果先给卦意、付费报告改为简版（report@2）。
 * 首个场景：「面试学校后，接下来能顺利入职吗？」，小畜 → 贲，九二、九五动。
 * 模型输出的质量（三种情形的下一步是否有实质区别、有没有编造）由真实模型评测与人工评审确认；
 * 这里验证结构、版本、Prompt 输入、校验与兼容，全部用本地替身。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import corpusJson from "@wenshan/content/generated/corpus.json";
import topicsJson from "@wenshan/content/generated/topics.json";
import { composeFreeReading, type CorpusBundle, type TopicsBundle } from "@wenshan/content";
import { castFromTosses, tossesFromLines } from "@wenshan/iching-core";
import { encryptJson } from "@/server/crypto";
import type { Env } from "@/server/env";
import type { DB } from "@/server/db/client";
import { followups, generationAttempts, orders, reports } from "@/server/db/schema";
import { drainJobs } from "@/server/jobs/runner";
import { __setLlmForTests, getLlm, type LlmProvider, type StructuredRequest } from "@/server/llm";
import { createOrderForReading, getOrderView, handlePaymentEvent } from "@/server/orders";
import { getPaymentProvider } from "@/server/payments";
import { completeFakeCheckout } from "@/server/payments/fake";
import { uploadReading } from "@/server/readings";
import { fakeReport } from "@/server/report/fake";
import { REPORT_SCHEMA_VERSION, mainText, type LegacyReportContent } from "@/server/report/schema";
import { getReportView, submitFollowup } from "@/server/report/service";
import { runTriage } from "@/server/triage";
import { confirmation, login as loginAt, setupTestServer, tossesFor } from "./helpers";

const corpus = corpusJson as unknown as CorpusBundle;
const topics = topicsJson as unknown as TopicsBundle;
const INTERVIEW = [7, 9, 7, 8, 9, 7] as const; // 小畜 → 贲，九二、九五动
const QUESTION = "面试学校后，接下来能顺利入职吗？";

const BASE: Partial<Env> = { PGLITE_DIR: "memory", APP_URL: "http://localhost:3000", SALES_ENABLED: true, ALLOW_UNREVIEWED_CONTENT: true, PRICE_AMOUNT_MINOR: 990 };
let db: DB;
beforeAll(async () => {
  db = await setupTestServer(BASE);
});

let ipSeq = 0;
const login = (email: string) => loginAt(email, `10.4.${Math.floor(++ipSeq / 200)}.${ipSeq % 200}`);
let n = 0;

async function deliveredFor(email: string, context: Record<string, string>, topicId: "career" | "love" = "career", question = QUESTION) {
  const user = await login(email);
  const clientReadingId = `round4-${++n}-xxxxxxxx`;
  const r = await uploadReading(user.id, { clientReadingId, question, topicId, topicOriginal: topicId, context, tosses: tossesFor([...INTERVIEW]), consent: true });
  await runTriage(user.id, r.readingId);
  const { orderId } = await createOrderForReading(user, await confirmation(r.readingId));
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  const { body, signature } = completeFakeCheckout(o!.providerSessionId!);
  await handlePaymentEvent(getPaymentProvider().parseWebhook(body, new Headers({ "x-fake-signature": signature })));
  await drainJobs();
  const view = await getOrderView(user.id, orderId);
  expect(view.status).toBe("delivered");
  return { user, orderId, reportId: view.reportId!, readingId: r.readingId };
}

/** 记录每次报告请求，可让第一次返回指定内容（例如编造了日期的报告） */
function recordingLlm(firstReport?: (req: StructuredRequest) => unknown) {
  const base = getLlm();
  const requests: StructuredRequest[] = [];
  let used = false;
  const stub: LlmProvider = {
    name: "fake",
    moderate: base.moderate,
    generateStructured: async (req) => {
      if (req.route === "report") {
        requests.push(req);
        if (firstReport && !used) {
          used = true;
          const meta = { model: "stub", effort: "none", latencyMs: 1, usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, reasoningTokens: 0 } };
          return { kind: "ok" as const, data: firstReport(req), ...meta };
        }
      }
      return base.generateStructured(req);
    },
  };
  __setLlmForTests(stub);
  return requests;
}

describe("free result · the meaning first, originals folded, no model call", () => {
  it("gives one grounded sentence from the key passage and a single hint", () => {
    const r = composeFreeReading({ cast: castFromTosses(tossesFromLines([...INTERVIEW])), topicId: "career", readingId: "x" }, corpus, topics);
    expect([r.primary.name, r.changed?.name, r.movingLines]).toEqual(["小畜", "贲", [2, 5]]);
    // 原文依据：引用的是本次重点（九二）的原字
    expect(r.gist.entryId).toBe("ZY.09.L2");
    expect(corpus.entries[r.gist.entryId]!.text.replace(/[，。]/g, "")).toContain(r.gist.quote.replace(/[，。]/g, ""));
    // 白话取落到处境上的那一句，并去掉"比喻"这样的引导词
    expect(r.gist.meaning).toBeTruthy();
    expect(r.gist.meaning).not.toMatch(/^比喻/);
    expect(corpus.annotations[r.gist.entryId]!.vernacular).toContain(r.gist.meaning!.replace(/……$/, ""));
    // 最多两句：「原文」：白话一句
    const sentences = `重点在「${r.gist.quote}」：${r.gist.meaning}`.split(/[。！？]/).filter((x) => x.trim());
    expect(sentences.length).toBeLessThanOrEqual(2);
    // 主题提示与反思问题收敛成一条提示
    expect(r.hint).toBe(r.topicHint);
    expect(r.hint.length).toBeGreaterThan(8);
  });

  it("covers every hexagram and moving-line count without empty or overlong gists", () => {
    for (let mask = 0; mask < 64; mask += 5) {
      for (const moving of [[], [1], [3, 6], [1, 2, 3, 4, 5, 6]]) {
        const lines = Array.from({ length: 6 }, (_, i) => {
          const yang = ((mask >> i) & 1) === 1;
          const m = (moving as number[]).includes(i + 1);
          return yang ? (m ? 9 : 7) : m ? 6 : 8;
        });
        const r = composeFreeReading({ cast: castFromTosses(tossesFromLines(lines as (6 | 7 | 8 | 9)[])), topicId: "other", readingId: "y" }, corpus, topics);
        expect(r.gist.quote.length, `${lines}`).toBeGreaterThan(0);
        expect(r.gist.quote.length).toBeLessThanOrEqual(24);
        if (r.gist.meaning) expect(r.gist.meaning.length).toBeLessThanOrEqual(62);
      }
    }
  });
});

describe("paid report · report@2 for the interview case", () => {
  it("delivers a concise report, versioned report@2, with citations rendered from ids and a scannable main text", async () => {
    const d = await deliveredFor("r4-fresh@example.com", { deadline: "刚面试完，对方没有说什么时候给结果" });
    const [rep] = await db.select().from(reports).where(eq(reports.id, d.reportId));
    expect((rep!.versions as Record<string, string>).schema).toBe(REPORT_SCHEMA_VERSION);
    expect((rep!.versions as Record<string, string>).prompt).toBe("report-prompt@3");
    const v = await getReportView(d.user.id, d.reportId);
    if ("deleted" in v || v.format !== "v2") throw new Error("expected a v2 report");
    expect(v.content.takeaway.length).toBeLessThanOrEqual(70);
    expect(mainText(v.content).length).toBeLessThanOrEqual(320);
    for (const b of v.content.basis) expect(v.citations[b.citation]?.text).toBeTruthy();
    expect(v.content.artifact?.kind).toBe("message");
  });

  it("puts the user's own timing facts and today's date into the prompt, with the rule to stay conditional", async () => {
    const requests = recordingLlm();
    const cases = {
      fresh: "刚面试完，对方没有说什么时候给结果",
      dated: "面试时对方说下周五前给答复，现在还没到下周五",
      overdue: "对方说上周五前给答复，现在已经过了约定时间，还没有收到消息",
    };
    const triggers: Record<string, string> = {};
    for (const [k, deadline] of Object.entries(cases)) {
      const d = await deliveredFor(`r4-${k}-prompt@example.com`, { deadline });
      const v = await getReportView(d.user.id, d.reportId);
      if ("deleted" in v || v.format !== "v2") throw new Error("expected v2");
      triggers[k] = v.content.next_step.trigger;
      const req = requests.at(-1)!;
      expect(req.user).toContain(deadline);
      expect(req.user).toMatch(/今天：\d{4}-\d{2}-\d{2}/);
      expect(req.schemaName).toBe("wenshan_report_v2");
    }
    // 规则写在系统层：没给日期就写成条件、不编进展与概率、主文 250 字
    const dev = requests[0]!.developer;
    for (const rule of ["没给时写成条件", "不要编造进展", "合计不超过 250 字", "准备蓄势"]) expect(dev).toContain(rule);
    // 替身按用户给的时间事实分三种写法；真实模型的区别由评测与人工评审确认
    expect(new Set(Object.values(triggers)).size).toBe(3);
    __setLlmForTests(null);
  });

  it("rejects a report that invents an interview date or a hiring probability, and retries with that feedback", async () => {
    const requests = recordingLlm((req) => {
      const good = fakeReport([], { topicId: "career", question: QUESTION, context: {}, summary: null, missingInfo: [] });
      // 第一次：模型自行填了面试日期和录用把握
      return {
        ...good,
        basis: [{ citation: "ZY.09.L2", text: "「牵复」说的是被牵引着回到正道。" }],
        next_step: { ...good.next_step, trigger: "你 11月18日 面试，等到下周三" },
        takeaway: "录用的可能性很大，先安心等结果，同时把联系保持住。",
        _req: req.route,
      };
    });
    const d = await deliveredFor("r4-fabricated@example.com", { deadline: "刚面试完，对方没有说什么时候给结果" });
    const attempts = await db.select().from(generationAttempts).where(and(eq(generationAttempts.orderId, d.orderId), eq(generationAttempts.kind, "report")));
    const codes = attempts.flatMap((a) => ((a.validatorErrors as string[] | null) ?? [])).join(" ");
    expect(attempts.map((a) => a.status)).toEqual(["invalid", "ok"]);
    expect(codes).toMatch(/日期|unsupported_date|11月18日/);
    expect(requests).toHaveLength(2);
    // 第二次请求带着反馈重试
    expect(requests[1]!.user).toContain("上一次输出没有通过校验");
    const v = await getReportView(d.user.id, d.reportId);
    if ("deleted" in v || v.format !== "v2") throw new Error("expected v2");
    expect(JSON.stringify(v.content)).not.toMatch(/11月18日|下周三|可能性很大/);
    __setLlmForTests(null);
  });

  it("accepts follow-ups on a concise report", async () => {
    const d = await deliveredFor("r4-followup@example.com", { deadline: "面试时对方说下周五前给答复，现在还没到下周五" });
    await submitFollowup(d.user.id, d.reportId, "如果下周五还没消息，消息里要不要提到我也在看别的学校？", "r4-fu-1");
    await drainJobs();
    const v = await getReportView(d.user.id, d.reportId);
    if ("deleted" in v) throw new Error("report gone");
    expect(v.followups[0]).toMatchObject({ status: "done" });
  });
});

describe("legacy reports (report@1) stay readable and accept follow-ups", () => {
  it("serves an old report in its original format and answers a follow-up on it", async () => {
    const d = await deliveredFor("r4-legacy@example.com", { deadline: "刚面试完，对方没有说什么时候给结果" });
    const legacy: LegacyReportContent = {
      question_summary: "面试学校后，想判断能否顺利入职，以及接下来怎么安排。",
      situation: "你刚面试完一所学校，还没有收到结果时间；同时在留意其他学校的招聘。目前最不清楚的是后续流程与时间。",
      observations: [{ angle: "保持联系", text: "九二「牵复」提示回到正轨要靠相互牵引：先把能确认的事问清楚，再安排下一步。", citations: ["ZY.09.L2"] }],
      to_verify: [{ item: "结果大约什么时候出", how: "向面试联系人礼貌确认。" }],
      seven_day_action: { what: "发一条简短消息确认结果时间，同时整理两所备选学校的要求。", by_when: "第 3 天前", feedback_signal: "对方给了时间就等到那时；没有回复就继续准备备选。" },
      review_condition: "收到结果、或一周仍无消息时回来再看。",
      followup_suggestions: [],
    };
    await db
      .update(reports)
      .set({ contentCt: encryptJson(legacy), versions: { schema: "report@1", prompt: "report-prompt@2" } })
      .where(eq(reports.id, d.reportId));
    const v = await getReportView(d.user.id, d.reportId);
    if ("deleted" in v) throw new Error("legacy report should be readable");
    expect(v.format).toBe("v1");
    expect(v.content).toMatchObject({ question_summary: legacy.question_summary });
    await submitFollowup(d.user.id, d.reportId, "如果一周后还没有消息，我该怎么问？", "r4-legacy-fu");
    await drainJobs();
    const [f] = await db.select().from(followups).where(eq(followups.orderId, d.orderId));
    expect(f!.status).toBe("done");
  });
});

describe("dev-only: same-origin check also accepts an Origin equal to the Host (127.0.0.1 next to localhost)", () => {
  it("accepts 127.0.0.1 in development, rejects foreign origins, and never relaxes in production", async () => {
    const { assertSameOrigin } = await import("@/server/http");
    const { __setEnvForTests } = await import("@/server/env");
    const req = (origin: string) =>
      new Request("http://localhost:3000/api/x", { method: "POST", headers: { origin, host: "127.0.0.1:3000", "sec-fetch-site": "same-origin" } });
    expect(() => assertSameOrigin(req("http://127.0.0.1:3000"))).not.toThrow();
    expect(() => assertSameOrigin(req("http://evil.example"))).toThrow();
    __setEnvForTests({ ...BASE, NODE_ENV: "production", SALES_ENABLED: false, ALLOW_UNREVIEWED_CONTENT: false });
    try {
      expect(() => assertSameOrigin(req("http://127.0.0.1:3000"))).toThrow();
      expect(() => assertSameOrigin(req("http://localhost:3000"))).not.toThrow();
    } finally {
      __setEnvForTests(BASE);
    }
  });
});
