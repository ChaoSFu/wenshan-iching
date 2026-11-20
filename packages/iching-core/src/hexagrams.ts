import { type Bit, TRIGRAMS, type TrigramId, trigramFromBits } from "./trigrams";

export const HEX_TABLE_VERSION = "kingwen@1";

/**
 * 文王序 64 卦的上下卦组成，下标 = 卦号 - 1。
 * 这份表是演算唯一的查表依据；内容包测试会用维基文库各卦页面的
 * "X下Y上"另行核对（见 packages/content/test/corpus.test.ts）。
 */
const COMPOSITION: ReadonlyArray<readonly [upper: TrigramId, lower: TrigramId]> = [
  ["qian", "qian"], // 1 乾
  ["kun", "kun"], // 2 坤
  ["kan", "zhen"], // 3 屯
  ["gen", "kan"], // 4 蒙
  ["kan", "qian"], // 5 需
  ["qian", "kan"], // 6 讼
  ["kun", "kan"], // 7 师
  ["kan", "kun"], // 8 比
  ["xun", "qian"], // 9 小畜
  ["qian", "dui"], // 10 履
  ["kun", "qian"], // 11 泰
  ["qian", "kun"], // 12 否
  ["qian", "li"], // 13 同人
  ["li", "qian"], // 14 大有
  ["kun", "gen"], // 15 谦
  ["zhen", "kun"], // 16 豫
  ["dui", "zhen"], // 17 随
  ["gen", "xun"], // 18 蛊
  ["kun", "dui"], // 19 临
  ["xun", "kun"], // 20 观
  ["li", "zhen"], // 21 噬嗑
  ["gen", "li"], // 22 贲
  ["gen", "kun"], // 23 剥
  ["kun", "zhen"], // 24 复
  ["qian", "zhen"], // 25 无妄
  ["gen", "qian"], // 26 大畜
  ["gen", "zhen"], // 27 颐
  ["dui", "xun"], // 28 大过
  ["kan", "kan"], // 29 坎
  ["li", "li"], // 30 离
  ["dui", "gen"], // 31 咸
  ["zhen", "xun"], // 32 恒
  ["qian", "gen"], // 33 遯
  ["zhen", "qian"], // 34 大壮
  ["li", "kun"], // 35 晋
  ["kun", "li"], // 36 明夷
  ["xun", "li"], // 37 家人
  ["li", "dui"], // 38 睽
  ["kan", "gen"], // 39 蹇
  ["zhen", "kan"], // 40 解
  ["gen", "dui"], // 41 损
  ["xun", "zhen"], // 42 益
  ["dui", "qian"], // 43 夬
  ["qian", "xun"], // 44 姤
  ["dui", "kun"], // 45 萃
  ["kun", "xun"], // 46 升
  ["dui", "kan"], // 47 困
  ["kan", "xun"], // 48 井
  ["dui", "li"], // 49 革
  ["li", "xun"], // 50 鼎
  ["zhen", "zhen"], // 51 震
  ["gen", "gen"], // 52 艮
  ["xun", "gen"], // 53 渐
  ["zhen", "dui"], // 54 归妹
  ["zhen", "li"], // 55 丰
  ["li", "gen"], // 56 旅
  ["xun", "xun"], // 57 巽
  ["dui", "dui"], // 58 兑
  ["xun", "kan"], // 59 涣
  ["kan", "dui"], // 60 节
  ["xun", "dui"], // 61 中孚
  ["zhen", "gen"], // 62 小过
  ["kan", "li"], // 63 既济
  ["li", "kan"], // 64 未济
];

const NUMBER_BY_KEY = new Map<string, number>(
  COMPOSITION.map(([upper, lower], i) => [`${upper}/${lower}`, i + 1]),
);

export interface HexagramComposition {
  number: number;
  upper: TrigramId;
  lower: TrigramId;
}

export function isHexagramNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 64;
}

export function hexagramComposition(n: number): HexagramComposition {
  const c = COMPOSITION[n - 1];
  if (!c) throw new RangeError(`hexagram number out of range: ${n}`);
  return { number: n, upper: c[0], lower: c[1] };
}

export function hexagramByTrigrams(upper: TrigramId, lower: TrigramId): number {
  const n = NUMBER_BY_KEY.get(`${upper}/${lower}`);
  if (n === undefined) throw new Error(`unknown trigram pair ${upper}/${lower}`);
  return n;
}

/** 六爻（从初爻到上爻）→ 文王序卦号。 */
export function hexagramFromBits(bits: readonly Bit[]): number {
  if (bits.length !== 6) throw new Error(`expected 6 lines, got ${bits.length}`);
  const lower = trigramFromBits(bits.slice(0, 3));
  const upper = trigramFromBits(bits.slice(3, 6));
  return hexagramByTrigrams(upper, lower);
}

/** 卦号 → 六爻（从初爻到上爻）。 */
export function bitsOfHexagram(n: number): Bit[] {
  const { upper, lower } = hexagramComposition(n);
  return [...TRIGRAMS[lower].bits, ...TRIGRAMS[upper].bits];
}

/** Unicode 六十四卦符号（U+4DC0 起按文王序排列）。 */
export function hexagramSymbol(n: number): string {
  hexagramComposition(n);
  return String.fromCodePoint(0x4dc0 + n - 1);
}
