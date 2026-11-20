import { supplementaryIds } from "@wenshan/content";
import { lineLabel, selectPassages, type Cast } from "@wenshan/iching-core";
import { corpus, topicsBundle } from "../content";

/**
 * 报告允许引用的原文：本次选文 + 本卦、变卦的彖传与大象（PRD §5 样例引用了《彖传》）。
 * 补充材料只纳入已审核的条目；测试配置（includeUnreviewed）可放宽。
 * 下单时整份冻结进订单快照，报告与追问只读快照。
 */
export interface AllowedPassage {
  id: string;
  title: string;
  text: string;
  vernacular: string | null;
  angleName: string | null;
  role: string;
  originalStatus: string;
  vernacularStatus: string | null;
}

export function allowedPassages(cast: Cast, opts: { includeUnreviewed: boolean }): { passages: AllowedPassage[]; missing: string[] } {
  const passages: AllowedPassage[] = [];
  const missing: string[] = [];
  const angleName = (id: string) => {
    const a = corpus.annotations[id]?.angles[0];
    return a ? (topicsBundle.angles.find((x) => x.id === a)?.name ?? null) : null;
  };
  const push = (id: string, role: string, required: boolean) => {
    const e = corpus.entries[id];
    if (!e) {
      if (required) missing.push(id);
      return;
    }
    const hex = corpus.hexagrams[String(e.hexagram)];
    const kindTitle =
      e.kind === "gua" ? "卦辞" : e.kind === "tuan" ? "彖传" : e.kind === "xiang" ? "大象" : (e.label ?? "");
    const ann = corpus.annotations[id];
    // 未审核的白话不进入真实报告的提示词
    const useVernacular = ann && (opts.includeUnreviewed || ann.reviewStatus === "reviewed");
    passages.push({
      id,
      title: `「${hex?.name ?? e.hexagram}」${kindTitle}`,
      text: e.text,
      vernacular: useVernacular ? ann.vernacular : null,
      angleName: angleName(id),
      role,
      originalStatus: e.reviewStatus,
      vernacularStatus: useVernacular ? ann.reviewStatus : null,
    });
  };

  for (const p of selectPassages(cast)) push(p.entryId, p.role, true);
  for (const id of supplementaryIds(cast, corpus, opts.includeUnreviewed)) push(id, "commentary", false);
  return { passages, missing };
}

export function castSummary(cast: Pick<Cast, "primary" | "changed" | "movingLines" | "lines">): string {
  const p = corpus.hexagrams[String(cast.primary)];
  const c = cast.changed === null ? null : corpus.hexagrams[String(cast.changed)];
  const moving = cast.movingLines.map((pos) => lineLabel(pos, cast.lines[pos - 1] === 7 || cast.lines[pos - 1] === 9));
  return [
    `本卦：第 ${cast.primary} 卦「${p?.name}」`,
    c ? `变卦：第 ${cast.changed} 卦「${c.name}」` : "没有变卦",
    moving.length ? `动爻：${moving.join("、")}` : "没有动爻",
  ].join("；");
}
