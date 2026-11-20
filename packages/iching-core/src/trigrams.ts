/** 0 = 阴（断线），1 = 阳（实线）。 */
export type Bit = 0 | 1;

export type TrigramId = "qian" | "dui" | "li" | "zhen" | "xun" | "kan" | "gen" | "kun";

export interface Trigram {
  id: TrigramId;
  /** 卦名（简体） */
  name: string;
  /** Unicode 八卦符号 */
  symbol: string;
  /** 取象 */
  image: string;
  /** 三爻，从下到上 */
  bits: readonly [Bit, Bit, Bit];
}

export const TRIGRAMS: Readonly<Record<TrigramId, Trigram>> = {
  qian: { id: "qian", name: "乾", symbol: "☰", image: "天", bits: [1, 1, 1] },
  dui: { id: "dui", name: "兑", symbol: "☱", image: "泽", bits: [1, 1, 0] },
  li: { id: "li", name: "离", symbol: "☲", image: "火", bits: [1, 0, 1] },
  zhen: { id: "zhen", name: "震", symbol: "☳", image: "雷", bits: [1, 0, 0] },
  xun: { id: "xun", name: "巽", symbol: "☴", image: "风", bits: [0, 1, 1] },
  kan: { id: "kan", name: "坎", symbol: "☵", image: "水", bits: [0, 1, 0] },
  gen: { id: "gen", name: "艮", symbol: "☶", image: "山", bits: [0, 0, 1] },
  kun: { id: "kun", name: "坤", symbol: "☷", image: "地", bits: [0, 0, 0] },
};

export const TRIGRAM_IDS = Object.keys(TRIGRAMS) as TrigramId[];

const BY_NAME = new Map<string, TrigramId>(
  TRIGRAM_IDS.flatMap((id) => {
    const t = TRIGRAMS[id];
    // 兼收繁体写法，便于从典籍来源解析"X下Y上"
    const trad: Record<string, string> = { dui: "兌", li: "離" };
    return trad[id] ? [[t.name, id], [trad[id]!, id]] : [[t.name, id]];
  }),
);

/** 按卦名（简体或繁体）查经卦，如 "乾"、"兌"。 */
export function trigramByName(name: string): TrigramId | undefined {
  return BY_NAME.get(name);
}

export function trigramFromBits(bits: readonly Bit[]): TrigramId {
  const id = TRIGRAM_IDS.find((k) => {
    const b = TRIGRAMS[k].bits;
    return b[0] === bits[0] && b[1] === bits[1] && b[2] === bits[2];
  });
  if (!id) throw new Error(`invalid trigram bits: ${bits.join("")}`);
  return id;
}
