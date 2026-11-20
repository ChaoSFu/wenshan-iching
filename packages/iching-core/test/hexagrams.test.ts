import { describe, expect, it } from "vitest";
import {
  TRIGRAMS,
  TRIGRAM_IDS,
  trigramFromBits,
  bitsOfHexagram,
  hexagramByTrigrams,
  hexagramComposition,
  hexagramFromBits,
  hexagramSymbol,
  trigramByName,
} from "../src";

describe("trigrams", () => {
  it("has eight distinct bit patterns", () => {
    const patterns = new Set(TRIGRAM_IDS.map((id) => TRIGRAMS[id].bits.join("")));
    expect(patterns.size).toBe(8);
    for (const id of TRIGRAM_IDS) expect(trigramFromBits(TRIGRAMS[id].bits)).toBe(id);
  });

  it("resolves simplified and traditional names", () => {
    expect(trigramByName("兑")).toBe("dui");
    expect(trigramByName("兌")).toBe("dui");
    expect(trigramByName("離")).toBe("li");
    expect(trigramByName("坎")).toBe("kan");
  });
});

describe("hexagram table", () => {
  it("maps 64 numbers onto 64 distinct trigram pairs", () => {
    const pairs = new Set<string>();
    for (let n = 1; n <= 64; n++) {
      const { upper, lower } = hexagramComposition(n);
      pairs.add(`${upper}/${lower}`);
      expect(hexagramByTrigrams(upper, lower)).toBe(n);
    }
    expect(pairs.size).toBe(64);
  });

  it("round-trips number → bits → number for all 64", () => {
    for (let n = 1; n <= 64; n++) {
      expect(hexagramFromBits(bitsOfHexagram(n))).toBe(n);
    }
  });

  it("matches well-known hexagrams (bits from 初爻 to 上爻)", () => {
    expect(hexagramFromBits([1, 1, 1, 1, 1, 1])).toBe(1); // 乾
    expect(hexagramFromBits([0, 0, 0, 0, 0, 0])).toBe(2); // 坤
    expect(hexagramFromBits([1, 0, 0, 0, 1, 0])).toBe(3); // 屯：震下坎上
    expect(hexagramFromBits([0, 1, 1, 1, 1, 1])).toBe(44); // 姤：巽下乾上
    expect(hexagramFromBits([1, 1, 1, 0, 0, 0])).toBe(11); // 泰：乾下坤上
    expect(hexagramFromBits([0, 0, 0, 1, 1, 1])).toBe(12); // 否：坤下乾上
    expect(hexagramFromBits([1, 0, 1, 0, 1, 0])).toBe(63); // 既济：离下坎上
    expect(hexagramFromBits([0, 1, 0, 1, 0, 1])).toBe(64); // 未济：坎下离上
  });

  it("uses the Unicode hexagram block in King Wen order", () => {
    expect(hexagramSymbol(1)).toBe("䷀");
    expect(hexagramSymbol(44)).toBe("䷫");
    expect(hexagramSymbol(64)).toBe("䷿");
  });
});
