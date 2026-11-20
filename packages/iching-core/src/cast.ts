import { type Bit } from "./trigrams";
import { HEX_TABLE_VERSION, hexagramFromBits } from "./hexagrams";

export const CAST_RULE_VERSION = "three-coin@1";

/** 反面 = 2，正面 = 3（PRD §6）。 */
export type Coin = 2 | 3;
export type Toss = readonly [Coin, Coin, Coin];
/** 6 老阴 · 7 少阳 · 8 少阴 · 9 老阳 */
export type LineValue = 6 | 7 | 8 | 9;

export interface Cast {
  ruleVersion: typeof CAST_RULE_VERSION;
  tableVersion: typeof HEX_TABLE_VERSION;
  /** 六轮掷币结果，下标 0 = 初爻 */
  tosses: Toss[];
  /** 六爻的值，下标 0 = 初爻 */
  lines: LineValue[];
  /** 本卦，文王序 1–64 */
  primary: number;
  /** 变卦；没有动爻时为 null */
  changed: number | null;
  /** 动爻位置 1–6，升序 */
  movingLines: number[];
}

export interface LineInfo {
  value: LineValue;
  /** 老阴 / 少阳 / 少阴 / 老阳 */
  name: string;
  yang: boolean;
  moving: boolean;
}

const LINE_INFO: Readonly<Record<LineValue, LineInfo>> = {
  6: { value: 6, name: "老阴", yang: false, moving: true },
  7: { value: 7, name: "少阳", yang: true, moving: false },
  8: { value: 8, name: "少阴", yang: false, moving: false },
  9: { value: 9, name: "老阳", yang: true, moving: true },
};

export function lineInfo(v: LineValue): LineInfo {
  return LINE_INFO[v];
}

export class CastValidationError extends Error {
  override name = "CastValidationError";
}

/** 填充随机字节的函数；默认用 Web Crypto（浏览器与 Node 20+ 都有）。 */
export type RandomBytes = (buf: Uint8Array) => void;

const cryptoRandom: RandomBytes = (buf) => {
  globalThis.crypto.getRandomValues(buf);
};

/**
 * 一次抽齐六轮、共 18 枚钱币（PRD §6：逐轮显示与一次完成使用同一批抽样）。
 * 每个随机字节只取最低位：1 = 正面（3），0 = 反面（2）。256 为偶数，故无偏。
 */
export function sampleTosses(random: RandomBytes = cryptoRandom): Toss[] {
  const buf = new Uint8Array(18);
  random(buf);
  const coin = (i: number): Coin => ((buf[i]! & 1) === 1 ? 3 : 2);
  return Array.from({ length: 6 }, (_, r) => [coin(r * 3), coin(r * 3 + 1), coin(r * 3 + 2)] as const);
}

export function lineValueOf(toss: Toss): LineValue {
  return (toss[0] + toss[1] + toss[2]) as LineValue;
}

function isCoin(x: unknown): x is Coin {
  return x === 2 || x === 3;
}

/** 校验来路不明的掷币数据（例如浏览器上传的值），通过后返回规范化副本。 */
export function parseTosses(input: unknown): Toss[] {
  if (!Array.isArray(input) || input.length !== 6) {
    throw new CastValidationError("tosses must be an array of 6 rounds");
  }
  return input.map((round: unknown, i): Toss => {
    if (!Array.isArray(round) || round.length !== 3) {
      throw new CastValidationError(`round ${i + 1} must be three coins of 2 or 3`);
    }
    const [a, b, c] = round as unknown[];
    if (!isCoin(a) || !isCoin(b) || !isCoin(c)) {
      throw new CastValidationError(`round ${i + 1} must be three coins of 2 or 3`);
    }
    return [a, b, c];
  });
}

/**
 * 唯一的推导入口：由原始掷币结果算出本卦、变卦与动爻。
 * 前端展示与服务端复算都调用它，保证结果一致（PRD §6）。
 */
export function castFromTosses(input: unknown): Cast {
  const tosses = parseTosses(input);
  const lines = tosses.map(lineValueOf);
  const primaryBits: Bit[] = lines.map((v) => (LINE_INFO[v].yang ? 1 : 0));
  const movingLines = lines.flatMap((v, i) => (LINE_INFO[v].moving ? [i + 1] : []));
  const changedBits: Bit[] = primaryBits.map((b, i) => (LINE_INFO[lines[i]!].moving ? (b === 1 ? 0 : 1) : b));
  return {
    ruleVersion: CAST_RULE_VERSION,
    tableVersion: HEX_TABLE_VERSION,
    tosses,
    lines,
    primary: hexagramFromBits(primaryBits),
    changed: movingLines.length > 0 ? hexagramFromBits(changedBits) : null,
    movingLines,
  };
}

/** 由六个爻值直接构造掷币结果（测试与样例用）。 */
export function tossesFromLines(lines: readonly LineValue[]): Toss[] {
  const byValue: Record<LineValue, Toss> = {
    6: [2, 2, 2],
    7: [3, 2, 2],
    8: [3, 3, 2],
    9: [3, 3, 3],
  };
  if (lines.length !== 6) throw new CastValidationError("expected 6 line values");
  return lines.map((v) => {
    const t = byValue[v];
    if (!t) throw new CastValidationError(`invalid line value ${String(v)}`);
    return t;
  });
}

const POSITION_NAMES = ["初", "二", "三", "四", "五", "上"] as const;

/** 爻题，如 初九、六二、上六。 */
export function lineLabel(position: number, yang: boolean): string {
  const pos = POSITION_NAMES[position - 1];
  if (!pos) throw new RangeError(`line position out of range: ${position}`);
  const num = yang ? "九" : "六";
  return position === 1 || position === 6 ? `${pos}${num}` : `${num}${pos}`;
}

/** 爻位名，如 初爻、二爻、上爻。 */
export function positionName(position: number): string {
  const pos = POSITION_NAMES[position - 1];
  if (!pos) throw new RangeError(`line position out of range: ${position}`);
  return `${pos}爻`;
}
