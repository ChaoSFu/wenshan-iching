import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { __setEnvForTests } from "@/server/env";
import { LlmTransientError, __setLlmForTests, getLlm, withTransportRetry, type LlmProvider } from "@/server/llm";
import {
  freezeBlindReports,
  loadBlindCases,
  loadCases,
  percentile,
  reviewSheet,
  runBlindFollowups,
  runEval,
  summarize,
  toMarkdown,
  unsupportedNumbers,
} from "@/server/eval/run";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CASES = path.join(root, "evals/cases.yaml");

beforeAll(() => {
  __setEnvForTests({ LLM_PROVIDER: "fake" });
  __setLlmForTests(null);
});

const base = { triageModel: "gpt-6.1-terra", reportModels: ["gpt-6.2-sol", "gpt-6.2-astra"], followupModels: ["gpt-6.2-sol", "gpt-6.1-terra"], effort: "low" as const };

describe("model eval harness (fake provider, no API calls)", () => {
  it("covers main and boundary cases for all five topics, plus thin-info, same-hexagram, same-question, follow-up and referral cases", () => {
    const cases = loadCases(CASES);
    const cats = new Set(cases.map((c) => c.category));
    for (const c of ["topic_sample", "topic_edge", "insufficient_info", "same_hex_diff_question", "same_question_diff_hex", "followup", "referral"]) {
      expect(cats.has(c), c).toBe(true);
    }
    for (const cat of ["topic_sample", "topic_edge"]) {
      expect(new Set(cases.filter((c) => c.category === cat).map((c) => c.topic)).size, cat).toBe(5);
    }
    // 五个主题的主场景都带同题追问
    expect(cases.filter((c) => c.category === "topic_sample" && c.followup).length).toBe(5);
  });

  it("runs every route through the production pipeline; triage expectations match the rules for every case", async () => {
    const cases = loadCases(CASES);
    const rows = await runEval({ llm: getLlm(), cases, ...base });
    expect(new Set(rows.filter((r) => r.route === "report").map((r) => r.model))).toEqual(new Set(["fake:gpt-6.2-sol", "fake:gpt-6.2-astra"]));
    expect(new Set(rows.filter((r) => r.route === "followup").map((r) => r.model))).toEqual(new Set(["fake:gpt-6.2-sol", "fake:gpt-6.1-terra"]));
    // 分流期望与 triage.yaml、enforceRules 一致（包括 sample-love：有机会复合吗 → 建议改问法）
    const mismatched = rows.filter((r) => r.route === "triage" && r.matchesExpectation === false).map((r) => `${r.caseId}:${r.decision}`);
    expect(mismatched).toEqual([]);
    expect(rows.find((r) => r.caseId === "sample-love" && r.route === "triage")!.decision).toBe("reframe_suggested");
    // 转介、必须改写的用例不生成报告
    for (const id of ["refer-health", "refer-legal", "refer-crisis", "refer-fertility", "edge-money-stock", "edge-other-multi"]) {
      expect(rows.some((r) => r.caseId === id && r.route === "report"), id).toBe(false);
    }
    for (const r of rows.filter((x) => x.route === "report")) {
      expect(r.passed, `${r.caseId} ${r.issueCodes.join(",")}`).toBe(true);
      expect(r.grounded).toBe(true);
      expect(r.businessAttempts).toBe(1);
    }
    // 替身没有用量：成本未知，而不是 0
    const summary = summarize(rows);
    const sol = summary.find((s) => s.route === "report" && s.model === "fake:gpt-6.2-sol")!;
    expect(sol.unknownCostRuns).toBe(sol.samples);
    expect(sol.avgCostUsd).toBeNull();
    const md = toMarkdown(summary, { live: false, date: "test", cases: cases.length });
    expect(md).toContain("| report | fake:gpt-6.2-sol |");
    expect(md).toContain("未知");
    expect(md).toContain("## 失败类型");
    // 人工评审表包含三项人工确认
    const sheet = reviewSheet(rows, cases);
    expect(sheet).toContain("- [ ] 引用支持解释");
    expect(sheet).toContain("- [ ] 没有编造现实事实（日期、进展、概率、他人想法）");
    expect(sheet).toContain("- [ ] 直接回应了问题");
    expect(sheet).toContain("- [ ] 用户能照着做");
  });

  it("marks follow-ups as not run when the baseline report fails, and records post-moderation failures separately", async () => {
    const fake = getLlm();
    // 报告：结构不合格（业务校验失败）；追问不应运行
    const broken: LlmProvider = {
      ...fake,
      async generateStructured(req) {
        const res = await fake.generateStructured(req);
        return req.route === "report" && res.kind === "ok" ? { ...res, data: { nope: true } } : res;
      },
    };
    const cases = loadCases(CASES).filter((c) => c.id === "sample-career");
    const rows = await runEval({ llm: broken, cases, ...base, reportModels: ["gpt-6.2-sol"] });
    const report = rows.find((r) => r.route === "report")!;
    expect(report.outcome).toBe("invalid");
    expect(report.businessAttempts).toBe(2);
    const followups = rows.filter((r) => r.route === "followup");
    expect(followups.map((r) => r.outcome)).toEqual(["not_run", "not_run"]);
    const s = summarize(rows).find((x) => x.route === "followup")!;
    expect(s.samples).toBe(0);
    expect(s.notRun).toBe(1);

    // 输出内容审核未通过：单独计为 moderation_flagged
    let calls = 0;
    const flagged: LlmProvider = {
      ...fake,
      async moderate(texts) {
        calls++;
        return calls === 1 ? fake.moderate(texts) : { flagged: true, categories: ["harassment"] };
      },
    };
    const rows2 = await runEval({ llm: flagged, cases, ...base, reportModels: ["gpt-6.2-sol"], followupModels: [] });
    const r2 = rows2.find((r) => r.route === "report")!;
    expect(r2.outcome).toBe("moderation_flagged");
    expect(r2.attemptOutcomes).toEqual(["moderation_flagged", "moderation_flagged"]);
    expect(summarize(rows2).find((x) => x.route === "report")!.outcomes).toEqual({ moderation_flagged: 1 });
  });

  it("separates transport failures from business attempts, and records request errors", async () => {
    const fake = getLlm();
    let n = 0;
    const flaky: LlmProvider = {
      ...fake,
      async generateStructured(req) {
        if (req.route !== "report") return fake.generateStructured(req);
        n++;
        if (n === 1) throw new LlmTransientError("429", [{ error: "429", latencyMs: 5 }, { error: "503", latencyMs: 5 }]);
        const res = await fake.generateStructured(req);
        return { ...res, transportFailures: [{ error: "timeout", latencyMs: 5 }] };
      },
    };
    const cases = loadCases(CASES).filter((c) => c.id === "sample-study");
    const rows = await runEval({ llm: flaky, cases, ...base, followupModels: [] });
    const [first, second] = rows.filter((r) => r.route === "report");
    expect(first).toMatchObject({ outcome: "request_error", businessAttempts: 0, transportFailures: 2 });
    expect(second).toMatchObject({ outcome: "ok", businessAttempts: 1, transportFailures: 1 });
  });

  it("transport retry resends only transient errors and reports every failed send", async () => {
    let n = 0;
    const sleep = async () => {};
    const ok = await withTransportRetry(
      async () => {
        if (++n < 3) throw new Error("503");
        return "done";
      },
      { retries: 2, classify: (e) => (e instanceof Error ? e.message : null), sleep },
    );
    expect(ok.value).toBe("done");
    expect(ok.failures.map((f) => f.error)).toEqual(["503", "503"]);
    await expect(withTransportRetry(async () => Promise.reject(new Error("429")), { retries: 1, classify: () => "429", sleep })).rejects.toMatchObject({
      transportFailures: [{ error: "429" }, { error: "429" }],
    });
    await expect(withTransportRetry(async () => Promise.reject(new Error("bad request")), { retries: 3, classify: () => null, sleep })).rejects.toThrow("bad request");
  });

  it("blind follow-up test: every model answers on the same frozen report and history, labels hide the model", async () => {
    const cases = loadBlindCases(path.join(root, "evals/followup-blind.yaml"));
    const frozen = await freezeBlindReports({ llm: getLlm(), cases, model: "gpt-6.2-sol", effort: "low" });
    expect(frozen).toHaveLength(cases.length);
    const prompts: string[] = [];
    const fake = getLlm();
    const spy: LlmProvider = {
      ...fake,
      async generateStructured(req) {
        if (req.route === "followup") prompts.push(req.user);
        return fake.generateStructured(req);
      },
    };
    const { items, key } = await runBlindFollowups({ llm: spy, cases, frozen, models: ["gpt-6.2-sol", "gpt-6.1-terra"], effort: "low", seed: 42 });
    const totalFollowups = cases.reduce((s, c) => s + c.followups.length, 0);
    expect(items).toHaveLength(totalFollowups * 2);
    for (const c of cases) {
      expect(new Set(Object.values(key[c.id]!))).toEqual(new Set(["gpt-6.2-sol", "gpt-6.1-terra"]));
      // 两个模型拿到的提示词完全相同（同一份报告、同一段历史、同一个问题）
      for (const f of c.followups) {
        const same = items.filter((i) => i.caseId === c.id && i.followup === f.question);
        expect(same.map((i) => i.label).sort()).toEqual(["A", "B"]);
      }
    }
    for (let i = 0; i < prompts.length; i += 2) expect(prompts[i]).toBe(prompts[i + 1]);
    expect(items.every((i) => i.row.passed)).toBe(true);
    // 冻结的报告被改坏时拒绝运行
    const tampered = frozen.map((f) => ({ ...f, report: { ...f.report, basis: [] } }));
    await expect(runBlindFollowups({ llm: fake, cases, frozen: tampered, models: ["gpt-6.2-sol"], effort: "low" })).rejects.toThrow(/no longer passes validation/);
  });

  it("flags numbers the user never gave; P90 uses nearest rank", () => {
    expect(unsupportedNumbers("预算 3000 元，回报 5 万元，第 3 天前完成", ["最多 3000 元"])).toEqual([]);
    expect(unsupportedNumbers("预计收益 12000 元", ["最多 3000 元"])).toEqual(["12000"]);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([5], 0.9)).toBe(5);
  });
});

describe("round 3 · reviewed-only gating, model selection and budget", () => {
  it("--reviewed-only uses the checkout content gate: blocked cases are counted apart and zero eligible samples say 'pending review', not 'bad model'", async () => {
    const { pendingContent } = await import("@/server/offer");
    const cases = loadCases(CASES).filter((c) => ["sample-career", "sample-love", "refer-legal"].includes(c.id));
    const rows = await runEval({ llm: getLlm(), cases, ...base, reviewedOnly: true });
    const gated = rows.filter((r) => r.outcome === "review_pending");
    // 与下单门槛一致：仓库里的内容都还是初稿，可购买的用例全部被挡住
    for (const r of gated) {
      const c = cases.find((x) => x.id === r.caseId)!;
      const { castFromTosses, tossesFromLines } = await import("@wenshan/iching-core");
      expect(pendingContent(castFromTosses(tossesFromLines(c.lines)), c.topic).length).toBeGreaterThan(0);
    }
    expect(gated.filter((r) => r.route === "report")).toHaveLength(4); // 2 个可购买用例 × 2 个报告模型
    const summary = summarize(rows);
    const sol = summary.find((s) => s.route === "report" && s.model === "gpt-6.2-sol")!;
    expect(sol).toMatchObject({ samples: 0, reviewBlocked: 2, notRun: 0 });
    const md = toMarkdown(summary, { live: false, date: "t", cases: cases.length, reviewedOnly: true });
    expect(md).toContain("不能据此判断模型质量");
    // 不加 --reviewed-only：与模拟流程一致，未审内容也参与
    const all = summarize(await runEval({ llm: getLlm(), cases, ...base }));
    expect(all.find((s) => s.route === "report" && s.model.endsWith("gpt-6.2-sol"))).toMatchObject({ samples: 2, reviewBlocked: 0 });
  });

  it("keeps the current follow-up route unless the candidate is no worse on errors, P90, cost and human fit", async () => {
    const { followupDecision } = await import("@/server/eval/run");
    const mk = (model: string, o: Partial<ReturnType<typeof summarize>[number]>) =>
      ({ route: "followup", model, samples: 10, passRate: 0.9, e2eP90Ms: 3000, knownCostUsd: 0.1, unknownCostShare: 0, ...o }) as ReturnType<typeof summarize>[number];
    const cur = mk("sol", {});
    expect(followupDecision([cur, mk("terra", { passRate: 0.8, knownCostUsd: 0.02 })], "sol", "terra").verdict).toBe("keep");
    expect(followupDecision([cur, mk("terra", { e2eP90Ms: 4000, knownCostUsd: 0.02 })], "sol", "terra").verdict).toBe("keep");
    expect(followupDecision([cur, mk("terra", { knownCostUsd: 0.02, unknownCostShare: 0.5 })], "sol", "terra").reasons.join()).toContain("成本未知");
    const better = [cur, mk("terra", { knownCostUsd: 0.02, e2eP90Ms: 2000 })];
    expect(followupDecision(better, "sol", "terra").verdict).toBe("needs_human_review");
    expect(followupDecision(better, "sol", "terra", { current: 4.2, candidate: 3.9 }).verdict).toBe("keep");
    expect(followupDecision(better, "sol", "terra", { current: 4.2, candidate: 4.3 }).verdict).toBe("switch");
    expect(followupDecision([mk("sol", { samples: 0 }), mk("terra", { samples: 0 })], "sol", "terra").verdict).toBe("insufficient");
  });

  it("the explicit budget stops before the next call once spent, and refuses to continue after an unknown-cost call", async () => {
    const { withBudget, BudgetExceededError } = await import("@/server/llm/budget");
    const fake = getLlm();
    const priced: LlmProvider = {
      ...fake,
      generateStructured: async (req) => ({ ...(await fake.generateStructured(req)), model: "gpt-6.2-sol", usage: { inputTokens: 200_000, cachedTokens: 0, outputTokens: 100_000, reasoningTokens: 0 } }),
    };
    const { buildTriageRequest } = await import("@/server/triage");
    const req = buildTriageRequest({ topicId: "career", question: "要不要接下这个项目？", context: {} }, "eval");
    const b = withBudget(priced, { budgetUsd: 0.000001 });
    await b.generateStructured(req);
    await expect(b.generateStructured(req)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(b.spent().calls).toBe(1);
    const unknown = withBudget(fake, { budgetUsd: 10 });
    await unknown.generateStructured(req); // 替身没有用量：成本未知
    await expect(unknown.generateStructured(req)).rejects.toThrow(/unknown cost/);
    const allowed = withBudget(fake, { budgetUsd: 10, allowUnknownCost: true });
    await allowed.generateStructured(req);
    await allowed.generateStructured(req);
    expect(allowed.spent()).toMatchObject({ calls: 2, unknownCalls: 2, knownUsd: 0 });
  });
});
