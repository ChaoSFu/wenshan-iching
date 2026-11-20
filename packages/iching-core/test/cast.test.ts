import { describe, expect, it } from "vitest";
import {
  type LineValue,
  CastValidationError,
  bitsOfHexagram,
  castFromTosses,
  lineLabel,
  lineValueOf,
  sampleTosses,
  selectPassages,
  tossesFromLines,
  guaId,
  yaoId,
  YONG_JIU_ID,
  YONG_LIU_ID,
  focusEntryId,
} from "../src";

const VALUES: LineValue[] = [6, 7, 8, 9];

/** 六爻四种取值的全部 4,096 种组合（PRD §9 免费闭环的通过条件）。 */
function* allCombinations(): Generator<LineValue[]> {
  for (let i = 0; i < 4 ** 6; i++) {
    yield Array.from({ length: 6 }, (_, pos) => VALUES[Math.floor(i / 4 ** pos) % 4]!);
  }
}

describe("castFromTosses", () => {
  it("reproduces the PRD §5 example: 9,7,7,7,7,7 → 乾初九动，变姤", () => {
    const cast = castFromTosses(tossesFromLines([9, 7, 7, 7, 7, 7]));
    expect(cast.lines).toEqual([9, 7, 7, 7, 7, 7]);
    expect(cast.primary).toBe(1);
    expect(cast.changed).toBe(44);
    expect(cast.movingLines).toEqual([1]);
  });

  it("has no changed hexagram when no line moves", () => {
    const cast = castFromTosses(tossesFromLines([7, 8, 7, 8, 7, 8]));
    expect(cast.movingLines).toEqual([]);
    expect(cast.changed).toBeNull();
    expect(cast.primary).toBe(63); // 既济
  });

  it("is consistent for all 4,096 line combinations", () => {
    let count = 0;
    for (const lines of allCombinations()) {
      const cast = castFromTosses(tossesFromLines(lines));
      const yang = lines.map((v) => (v === 7 || v === 9 ? 1 : 0));
      const moving = lines.flatMap((v, i) => (v === 6 || v === 9 ? [i + 1] : []));
      const flipped = yang.map((b, i) => (moving.includes(i + 1) ? 1 - b : b));

      expect(bitsOfHexagram(cast.primary)).toEqual(yang);
      expect(cast.movingLines).toEqual(moving);
      if (moving.length === 0) {
        expect(cast.changed).toBeNull();
      } else {
        expect(bitsOfHexagram(cast.changed!)).toEqual(flipped);
      }
      count++;
    }
    expect(count).toBe(4096);
  });

  it("rejects malformed tosses", () => {
    expect(() => castFromTosses([])).toThrow(CastValidationError);
    expect(() => castFromTosses(Array(6).fill([3, 3]))).toThrow(CastValidationError);
    expect(() => castFromTosses(Array(6).fill([3, 3, 4]))).toThrow(CastValidationError);
    expect(() => castFromTosses("x")).toThrow(CastValidationError);
  });
});

describe("sampleTosses", () => {
  it("returns six rounds of three coins", () => {
    const t = sampleTosses();
    expect(t).toHaveLength(6);
    for (const round of t) {
      expect(round).toHaveLength(3);
      for (const c of round) expect([2, 3]).toContain(c);
    }
  });

  it("maps the low bit of each byte to a coin", () => {
    const t = sampleTosses((buf) => buf.set(Array.from({ length: 18 }, (_, i) => (i % 2 === 0 ? 0xff : 0xfe))));
    expect(t[0]).toEqual([3, 2, 3]);
    expect(t[1]).toEqual([2, 3, 2]);
  });

  it("produces 6/7/8/9 at about 1/8, 3/8, 3/8, 1/8", () => {
    const counts: Record<LineValue, number> = { 6: 0, 7: 0, 8: 0, 9: 0 };
    const rounds = 200_000;
    for (let i = 0; i < rounds; i++) {
      for (const toss of sampleTosses()) counts[lineValueOf(toss)]++;
    }
    const n = rounds * 6;
    const expected: Record<LineValue, number> = { 6: n / 8, 7: (3 * n) / 8, 8: (3 * n) / 8, 9: n / 8 };
    const chi2 = VALUES.reduce((s, v) => s + (counts[v] - expected[v]) ** 2 / expected[v], 0);
    // 自由度 3，p = 1e-6 时临界值约 30.7：真实偏差会远超此值，随机误报可忽略
    expect(chi2).toBeLessThan(30.7);
  });
});

describe("selectPassages (select@1)", () => {
  it("0 moving: only the primary judgement", () => {
    const cast = castFromTosses(tossesFromLines([7, 7, 7, 7, 7, 7]));
    expect(selectPassages(cast)).toEqual([{ entryId: "ZY.01.G", role: "primary", from: "primary" }]);
    expect(focusEntryId(cast)).toBe("ZY.01.G");
  });

  it("1 moving: judgement as background, the moving line highlighted, changed judgement expandable", () => {
    const cast = castFromTosses(tossesFromLines([9, 7, 7, 7, 7, 7]));
    expect(selectPassages(cast)).toEqual([
      { entryId: "ZY.01.G", role: "background", from: "primary" },
      { entryId: "ZY.01.L1", role: "primary", from: "primary" },
      { entryId: "ZY.44.G", role: "expandable", from: "changed" },
    ]);
    expect(focusEntryId(cast)).toBe("ZY.01.L1");
  });

  it("2–6 moving: all moving lines bottom-up, then both judgements", () => {
    const cast = castFromTosses(tossesFromLines([7, 6, 7, 9, 7, 7]));
    const ids = selectPassages(cast).map((p) => p.entryId);
    expect(ids).toEqual([yaoId(cast.primary, 2), yaoId(cast.primary, 4), guaId(cast.primary), guaId(cast.changed!)]);
  });

  it("adds 用九 / 用六 only when 乾 or 坤 changes in all six lines", () => {
    const qian = castFromTosses(tossesFromLines([9, 9, 9, 9, 9, 9]));
    expect(qian.changed).toBe(2);
    expect(selectPassages(qian).at(-1)).toEqual({ entryId: YONG_JIU_ID, role: "supplement", from: "primary" });

    const kun = castFromTosses(tossesFromLines([6, 6, 6, 6, 6, 6]));
    expect(kun.changed).toBe(1);
    expect(selectPassages(kun).at(-1)).toEqual({ entryId: YONG_LIU_ID, role: "supplement", from: "primary" });

    const fiveOfQian = castFromTosses(tossesFromLines([9, 9, 9, 9, 9, 7]));
    expect(selectPassages(fiveOfQian).some((p) => p.role === "supplement")).toBe(false);
  });

  it("selects a valid, duplicate-free passage list for all 4,096 combinations", () => {
    for (const lines of allCombinations()) {
      const cast = castFromTosses(tossesFromLines(lines));
      const passages = selectPassages(cast);
      const ids = passages.map((p) => p.entryId);
      const m = cast.movingLines.length;
      const expectedLength = m === 0 ? 1 : m === 1 ? 3 : m + 2 + (m === 6 && (cast.primary === 1 || cast.primary === 2) ? 1 : 0);
      expect(passages).toHaveLength(expectedLength);
      // 本卦与变卦不同（有动爻时），所以编号不会重复
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^ZY\.\d{2}\.(G|L[1-6]|Y9|Y6)$/);
    }
  });
});

describe("lineLabel", () => {
  it("names lines in the traditional way", () => {
    expect(lineLabel(1, true)).toBe("初九");
    expect(lineLabel(2, false)).toBe("六二");
    expect(lineLabel(5, true)).toBe("九五");
    expect(lineLabel(6, false)).toBe("上六");
  });
});
