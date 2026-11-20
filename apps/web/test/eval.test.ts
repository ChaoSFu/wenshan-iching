import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { __setEnvForTests } from "@/server/env";
import { __setLlmForTests, getLlm } from "@/server/llm";
import { loadCases, runEval, summarize, toMarkdown, unsupportedNumbers } from "@/server/eval/run";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

beforeAll(() => {
  __setEnvForTests({ LLM_PROVIDER: "fake" });
  __setLlmForTests(null);
});

describe("model eval harness (fake provider, no API calls)", () => {
  it("covers the five topics plus thin-info, same-hexagram, same-question, follow-up and referral cases", () => {
    const cases = loadCases(path.join(root, "evals/cases.yaml"));
    const cats = new Set(cases.map((c) => c.category));
    for (const c of ["topic_sample", "insufficient_info", "same_hex_diff_question", "same_question_diff_hex", "followup", "referral"]) {
      expect(cats.has(c), c).toBe(true);
    }
    expect(new Set(cases.filter((c) => c.category === "topic_sample").map((c) => c.topic)).size).toBe(5);
  });

  it("runs every route against each configured model and stops at referrals", async () => {
    const cases = loadCases(path.join(root, "evals/cases.yaml"));
    const rows = await runEval({
      llm: getLlm(),
      cases,
      triageModel: "gpt-6.1-terra",
      reportModels: ["gpt-6.2-sol", "gpt-6.2-astra"],
      followupModels: ["gpt-6.2-sol", "gpt-6.1-terra"],
      effort: "low",
    });
    const reportModels = new Set(rows.filter((r) => r.route === "report").map((r) => r.model));
    expect(reportModels).toEqual(new Set(["fake:gpt-6.2-sol", "fake:gpt-6.2-astra"]));
    expect(new Set(rows.filter((r) => r.route === "followup").map((r) => r.model))).toEqual(new Set(["fake:gpt-6.2-sol", "fake:gpt-6.1-terra"]));
    // 转介用例不生成报告，且分流结果符合期望
    for (const id of ["refer-health", "refer-legal", "refer-crisis"]) {
      expect(rows.some((r) => r.caseId === id && r.route === "report")).toBe(false);
      expect(rows.filter((r) => r.caseId === id && r.route === "triage").some((r) => r.matchesExpectation === true)).toBe(true);
    }
    // 替身产出的报告通过校验、有原文依据、行动可执行
    for (const r of rows.filter((x) => x.route === "report")) {
      expect(r.passed, `${r.caseId} ${r.issues.join(",")}`).toBe(true);
      expect(r.grounded).toBe(true);
    }
    const md = toMarkdown(summarize(rows), { live: false, date: "test", cases: cases.length });
    expect(md).toContain("| report | fake:gpt-6.2-sol |");
  });

  it("flags numbers the user never gave", () => {
    expect(unsupportedNumbers("预算 3000 元，回报 5 万元，第 3 天前完成", ["最多 3000 元"])).toEqual([]);
    expect(unsupportedNumbers("预计收益 12000 元", ["最多 3000 元"])).toEqual(["12000"]);
  });
});
