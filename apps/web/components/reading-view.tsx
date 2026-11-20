import type { FreeReading, HexagramView, PassageView } from "@wenshan/content";
import { lineLabel } from "@wenshan/iching-core";
import { HexagramFigure } from "./hexagram-figure";

/** 传统全称：八纯卦为「乾为天」，其余为上象 + 下象 + 卦名，如「天风姤」。 */
function fullName(hex: HexagramView): string {
  return hex.upperName === hex.lowerName ? `${hex.name}为${hex.upperImage}` : `${hex.upperImage}${hex.lowerImage}${hex.name}`;
}

function HexagramCard({ hex, moving, caption, size }: { hex: HexagramView; moving: number[]; caption: string; size: "md" | "lg" }) {
  const label = `${hex.name}卦，${hex.upperName}上${hex.lowerName}下${
    moving.length ? `，${moving.map((p) => lineLabel(p, hex.bits[p - 1] === 1)).join("、")}动` : ""
  }`;
  return (
    <div className="flex min-w-0 flex-col items-center gap-3">
      <p className="text-xs text-muted">{caption}</p>
      <HexagramFigure bits={hex.bits} moving={moving} size={size} label={label} />
      <div className="text-center">
        <p className="font-serif text-2xl text-ink">
          {hex.name}
          <span className="ml-1 text-base text-muted" aria-hidden>
            {hex.symbol}
          </span>
        </p>
        <p className="text-xs leading-5 text-muted">
          第 {hex.number} 卦
          <br className="sm:hidden" />
          <span className="hidden sm:inline"> · </span>
          {fullName(hex)} · {hex.upperName}上{hex.lowerName}下
        </p>
      </div>
    </div>
  );
}

function PassageCard({ p, emphasis }: { p: PassageView; emphasis: boolean }) {
  const title = p.title.startsWith("「") ? p.title : `「${p.hexagramName}」${p.title}`;
  return (
    <article className={`rounded-2xl border p-5 ${emphasis ? "border-qing/50 bg-card shadow-sm" : "border-line bg-card/70"}`}>
      <header className="flex items-center justify-between gap-3">
        <h3 className="text-sm text-muted">{title}</h3>
        {p.role === "primary" && emphasis && <span className="rounded bg-zhu-soft px-2 py-0.5 text-xs text-zhu">本次重点</span>}
        {p.role === "supplement" && <span className="rounded bg-lu-soft px-2 py-0.5 text-xs text-qing">补充原文</span>}
      </header>
      <p className={`mt-2 font-serif leading-relaxed text-ink ${emphasis ? "text-2xl" : "text-xl"}`}>{p.text}</p>
      {p.vernacular ? (
        <p className="mt-3 text-[15px] leading-7 text-ink-soft">
          {p.vernacular}
          {p.vernacularStatus !== "reviewed" && <span className="ml-1.5 align-middle text-xs text-muted">（注释初稿）</span>}
        </p>
      ) : (
        <p className="mt-3 text-sm text-muted">这条的白话注释还在撰写和审校中。</p>
      )}
      <details className="mt-3 text-xs text-muted">
        <summary className="cursor-pointer select-none">出处与繁体原文</summary>
        <div className="mt-2 space-y-1">
          <p className="font-serif text-sm text-ink-soft">{p.textTrad}</p>
          <p>
            编号 {p.entryId} ·{" "}
            <span>{p.originalStatus === "reviewed" ? "已对勘" : "原文待人工对勘"}</span>
          </p>
        </div>
      </details>
    </article>
  );
}

export function ReadingView({ reading, topicName }: { reading: FreeReading; topicName: string }) {
  const { primary, changed, movingLines, passages } = reading;
  const single = movingLines.length === 1;
  const main = passages.filter((p) => p.role === "primary");
  const background = passages.filter((p) => p.role === "background");
  const expandable = passages.filter((p) => p.role === "expandable");
  const supplement = passages.filter((p) => p.role === "supplement");
  const movingText = movingLines.length
    ? `动爻：${movingLines.map((p) => lineLabel(p, primary.bits[p - 1] === 1)).join("、")}`
    : "这次没有动爻，读本卦卦辞。";

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-line bg-card p-5" aria-label="卦象">
        <div className={`flex items-center justify-center gap-3 sm:gap-6 ${changed ? "sm:gap-14" : ""}`}>
          <HexagramCard hex={primary} moving={movingLines} caption="本卦" size="lg" />
          {changed && (
            <>
              <span aria-hidden className="font-serif text-2xl text-muted">
                →
              </span>
              <HexagramCard hex={changed} moving={[]} caption="变卦" size="md" />
            </>
          )}
        </div>
        <p className="mt-4 text-center text-sm text-ink-soft">{movingText}</p>
      </section>

      <section className="space-y-3" aria-label="原文">
        {/* 1 动：卦辞作背景放在前面，突出该爻；多动：先列动爻，再列两卦卦辞 */}
        {single && background.map((p) => <PassageCard key={p.entryId} p={p} emphasis={false} />)}
        {main.map((p) => (
          <PassageCard key={p.entryId} p={p} emphasis />
        ))}
        {!single && background.map((p) => <PassageCard key={p.entryId} p={p} emphasis={false} />)}
        {supplement.map((p) => (
          <PassageCard key={p.entryId} p={p} emphasis={false} />
        ))}
        {expandable.map((p) => (
          <details key={p.entryId} className="group rounded-2xl border border-dashed border-line px-5 py-3">
            <summary className="cursor-pointer text-sm text-ink-soft">展开变卦「{p.hexagramName}」的卦辞</summary>
            <div className="mt-3">
              <PassageCard p={p} emphasis={false} />
            </div>
          </details>
        ))}
      </section>

      <section className="rounded-2xl bg-lu-soft/70 p-5" aria-label="简读">
        <p className="text-xs text-qing">
          放在「{topicName}」里看{reading.focusAngleName ? ` · 观察角度：${reading.focusAngleName}` : ""}
        </p>
        <p className="mt-2 text-base leading-7 text-ink">{reading.topicHint}</p>
      </section>

      <section className="rounded-2xl border border-line bg-card p-5" aria-label="反思问题">
        <p className="text-xs text-muted">留给你的一个问题</p>
        <p className="mt-2 font-serif text-lg leading-8 text-ink">{reading.reflectionQuestion}</p>
      </section>
    </div>
  );
}
