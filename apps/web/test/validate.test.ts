import { describe, expect, it } from "vitest";
import { castFromTosses, tossesFromLines } from "@wenshan/iching-core";
import { __setEnvForTests } from "@/server/env";
import { fakeReport } from "@/server/report/fake";
import { allowedPassages } from "@/server/report/passages";
import { validateReport, type ValidationContext } from "@/server/report/validate";

__setEnvForTests({});
const cast = castFromTosses(tossesFromLines([9, 7, 7, 7, 7, 7]));
const { passages } = allowedPassages(cast, { includeUnreviewed: true });
const situation = { topicId: "career" as const, question: "要不要转产品岗？", context: {}, summary: null, missingInfo: [] };
const ctx: ValidationContext = {
  allowedIds: new Set(passages.map((p) => p.id)),
  quotableSources: [...passages.map((p) => p.text), situation.question],
};

function withText(text: string) {
  const r = fakeReport(passages, situation);
  return { ...r, situation: `${r.situation}${text}` };
}

describe("validateReport", () => {
  it("allows the PRD §5 citations (乾初九 and 姤彖传) and accepts a clean report", () => {
    expect(ctx.allowedIds.has("ZY.01.L1")).toBe(true);
    expect(ctx.allowedIds.has("ZY.44.TUAN")).toBe(true);
    expect(validateReport(fakeReport(passages, situation), ctx).ok).toBe(true);
  });

  it.each([
    ["这是命中注定的。", "fatalism"],
    ["照做一定能成功。", "guarantee"],
    ["可以请人做一场法事化解。", "paid_remedy"],
    ["对方心里肯定是不想见你。", "motive_assertion"],
    ["这只股票下周会涨。", "investment"],
  ])("rejects %s", (text, code) => {
    const r = validateReport(withText(text), ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.code)).toContain(code);
  });

  it("does not flag hedged wording such as 不一定能", () => {
    expect(validateReport(withText("这一步不一定能马上看到结果。"), ctx).ok).toBe(true);
  });

  it("does not flag ordinary uses of 化解 (e.g. the 解 hexagram's commentary)", () => {
    expect(validateReport(withText("比喻以正道化解问题，不必急于求成。"), ctx).ok).toBe(true);
    expect(validateReport(withText("可以花钱请人帮你化解。"), ctx).ok).toBe(false);
  });

  it("rejects citations outside the allowed set and misquoted classics", () => {
    const r = fakeReport(passages, situation);
    const bad = { ...r, observations: [{ ...r.observations[0]!, citations: ["ZY.30.L2"] }] };
    expect(validateReport(bad, ctx)).toMatchObject({ ok: false });
    const quoted = withText("原文说「潜龙必胜」。");
    const res = validateReport(quoted, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.map((i) => i.code)).toContain("unverified_quote");
    expect(validateReport(withText("原文「潜龙勿用」提醒先准备。"), ctx).ok).toBe(true);
  });
});
