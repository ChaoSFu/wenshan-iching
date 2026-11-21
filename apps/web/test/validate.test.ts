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
  return { ...r, next_step: { ...r.next_step, signal: `${r.next_step.signal}${text}` } };
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
    const bad = { ...r, basis: [{ ...r.basis[0]!, citation: "ZY.30.L2" }] };
    expect(validateReport(bad, ctx)).toMatchObject({ ok: false });
    const quoted = withText("原文说「潜龙必胜」。");
    const res = validateReport(quoted, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.map((i) => i.code)).toContain("unverified_quote");
    expect(validateReport(withText("原文「潜龙勿用」提醒先准备。"), ctx).ok).toBe(true);
  });
});

describe("validateReport · report@2 facts, length and grounding (round 4)", () => {
  const facts: ValidationContext = {
    ...ctx,
    mainIds: new Set(passages.filter((p) => p.role === "primary").map((p) => p.id)),
    factSources: ["面试学校后，接下来能顺利入职吗？", "面试时对方说下周五前给答复", "2026-11-21", "11月21日"],
  };
  const base = () => fakeReport(passages, { ...situation, topicId: "career" as const });
  const withStep = (patch: Partial<ReturnType<typeof base>["next_step"]>) => ({ ...base(), next_step: { ...base().next_step, ...patch } });

  it("accepts dates the user gave, and rejects dates, weekdays or probabilities the user never gave", () => {
    expect(validateReport(withStep({ trigger: "到下周五对方给答复之前" }), facts).ok).toBe(true);
    for (const [trigger, code] of [
      ["面试是 11月18日，下周一再问", "unsupported_date"],
      ["等到周三还没消息时", "unsupported_date"],
      ["对方通常 12号 前回复", "unsupported_date"],
    ] as const) {
      const r = validateReport(withStep({ trigger }), facts);
      expect(r.ok, trigger).toBe(false);
      if (!r.ok) expect(r.issues.map((i) => i.code)).toContain(code);
    }
    for (const signal of ["录用的可能性很大，可以放心等。", "大概有 70% 的机会。", "被录取的把握不高，要多投几家。"]) {
      const r = validateReport(withStep({ signal }), facts);
      expect(r.ok, signal).toBe(false);
      if (!r.ok) expect(r.issues.map((i) => i.code)).toContain("probability");
    }
  });

  it("caps the main text (takeaway + next step) and requires at least one basis from this reading's passages", () => {
    // 每个字段都在自身上限内，但合计 68 + 80 + 138 + 100 = 386 字，超过主文上限
    const long = { ...base(), takeaway: "稳".repeat(68), next_step: { trigger: "等".repeat(80), action: "问".repeat(138), signal: "看".repeat(100) } };
    const r = validateReport(long, facts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.code)).toContain("too_long");
    // 只引卦辞或彖传、不引本次动爻（乾初九）：不算有依据
    const offReading = { ...base(), basis: [{ citation: "ZY.01.G", text: "卦辞讲元亨利贞，说的是开端顺畅。" }, { citation: "ZY.44.TUAN", text: "彖传以遇解姤，主动接触才能看清。" }] };
    const g = validateReport(offReading, facts);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.issues.map((i) => i.code)).toContain("basis_off_reading");
  });
});
