import type { Cast } from "./cast";

export const SELECTION_RULE_VERSION = "select@1";

/** 原文编号：ZY.{卦号两位}.G / .L{1-6} / ZY.01.Y9 / ZY.02.Y6 / .TUAN / .XIANG（PRD §7）。 */
export function guaId(hexagram: number): string {
  return `ZY.${pad(hexagram)}.G`;
}

export function yaoId(hexagram: number, line: number): string {
  if (line < 1 || line > 6) throw new RangeError(`line out of range: ${line}`);
  return `ZY.${pad(hexagram)}.L${line}`;
}

export const YONG_JIU_ID = "ZY.01.Y9";
export const YONG_LIU_ID = "ZY.02.Y6";

export function tuanId(hexagram: number): string {
  return `ZY.${pad(hexagram)}.TUAN`;
}

export function xiangId(hexagram: number): string {
  return `ZY.${pad(hexagram)}.XIANG`;
}

function pad(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 64) throw new RangeError(`hexagram out of range: ${n}`);
  return String(n).padStart(2, "0");
}

/**
 * primary     本次重点阅读的原文
 * background  提供背景的卦辞
 * expandable  默认折叠、可展开查看
 * supplement  补充原文（用九 / 用六）
 */
export type PassageRole = "primary" | "background" | "expandable" | "supplement";

export interface Passage {
  entryId: string;
  role: PassageRole;
  /** 这条原文属于本卦还是变卦 */
  from: "primary" | "changed";
}

/**
 * 选文规则 v1（PRD §6「免费解读怎样选原文」）：
 * - 0 动：本卦卦辞，页面注明没有动爻；
 * - 1 动：本卦卦辞作背景，突出该爻爻辞，变卦卦辞可展开；
 * - 2–6 动：从下到上列出所有动爻爻辞，另列本卦和变卦卦辞；
 * - 乾或坤六爻全变：另加用九 / 用六。
 */
export function selectPassages(cast: Pick<Cast, "primary" | "changed" | "movingLines">): Passage[] {
  const { primary, changed, movingLines: m } = cast;
  if (m.length === 0) {
    return [{ entryId: guaId(primary), role: "primary", from: "primary" }];
  }
  if (changed === null) throw new Error("cast with moving lines must have a changed hexagram");
  if (m.length === 1) {
    return [
      { entryId: guaId(primary), role: "background", from: "primary" },
      { entryId: yaoId(primary, m[0]!), role: "primary", from: "primary" },
      { entryId: guaId(changed), role: "expandable", from: "changed" },
    ];
  }
  const out: Passage[] = [
    ...m.map((line): Passage => ({ entryId: yaoId(primary, line), role: "primary", from: "primary" })),
    { entryId: guaId(primary), role: "background", from: "primary" },
    { entryId: guaId(changed), role: "background", from: "changed" },
  ];
  if (m.length === 6 && primary === 1) out.push({ entryId: YONG_JIU_ID, role: "supplement", from: "primary" });
  if (m.length === 6 && primary === 2) out.push({ entryId: YONG_LIU_ID, role: "supplement", from: "primary" });
  return out;
}

/**
 * 免费简读用来取"观察角度"的焦点原文（技术方案 5.5）：
 * 1 动取该爻，0 动取卦辞，多动取最下面的动爻。
 */
export function focusEntryId(cast: Pick<Cast, "primary" | "movingLines">): string {
  const first = cast.movingLines[0];
  return first === undefined ? guaId(cast.primary) : yaoId(cast.primary, first);
}
