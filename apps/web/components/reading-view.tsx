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

/** 紧凑卦象摘要：一行小卦画 + 卦名 + 动爻（免费页与报告页首屏用） */
export function HexagramSummary({ reading }: { reading: Pick<FreeReading, "primary" | "changed" | "movingLines"> }) {
  const { primary, changed, movingLines } = reading;
  const moving = movingLines.length ? `${movingLines.map((p) => lineLabel(p, primary.bits[p - 1] === 1)).join("、")}动` : "无动爻";
  return (
    <div className="flex items-center gap-3" aria-label="卦象摘要">
      <HexagramFigure bits={primary.bits} moving={movingLines} size="sm" label={`${primary.name}卦，${moving}`} />
      <div className="min-w-0">
        <p className="font-serif text-lg leading-7 text-ink">
          {primary.name}
          {changed && <span className="text-muted"> → </span>}
          {changed?.name}
        </p>
        <p className="text-xs leading-5 text-muted">
          {fullName(primary)}
          {changed ? ` → ${fullName(changed)}` : ""} · {moving}
        </p>
      </div>
    </div>
  );
}

/** 首屏的一句卦意（有原文依据）和唯一的提示。不调用模型 */
export function ReadingGist({ reading }: { reading: Pick<FreeReading, "gist" | "hint"> }) {
  const { gist, hint } = reading;
  return (
    <section className="rounded-2xl border border-qing/30 bg-card p-5" aria-label="卦意">
      <p className="text-xs text-qing">卦意</p>
      <p className="mt-2 font-serif text-lg leading-8 text-ink">
        重点在「{gist.quote}」
        {gist.meaning ? (
          <>
            ：{gist.meaning}
            {gist.draft && <span className="ml-1 align-middle font-sans text-xs text-muted">（注释初稿）</span>}
          </>
        ) : (
          "。"
        )}
      </p>
      <p className="mt-3 border-t border-line pt-3 text-[15px] leading-7 text-ink-soft">
        <span className="text-muted">提示：</span>
        {hint}
      </p>
    </section>
  );
}

/** 卦图、完整爻辞、白话注释与出处：默认折叠 */
export function ReadingDetails({ reading, defaultOpen = false }: { reading: FreeReading; defaultOpen?: boolean }) {
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
    <details open={defaultOpen} className="group rounded-2xl border border-line bg-card/60">
      <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-[15px] text-ink">
        <span>查看卦象与原文</span>
        <span aria-hidden className="text-muted transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>
      <div className="space-y-4 px-3 pb-4 sm:px-5">
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
            <details key={p.entryId} className="rounded-2xl border border-dashed border-line px-5 py-3">
              <summary className="cursor-pointer text-sm text-ink-soft">展开变卦「{p.hexagramName}」的卦辞</summary>
              <div className="mt-3">
                <PassageCard p={p} emphasis={false} />
              </div>
            </details>
          ))}
        </section>
      </div>
    </details>
  );
}

/** 免费结果的完整呈现（样例页用）：卦象摘要 → 卦意与提示 → 折叠的卦象与原文 */
export function ReadingView({ reading }: { reading: FreeReading; topicName?: string }) {
  return (
    <div className="space-y-4">
      <HexagramSummary reading={reading} />
      <ReadingGist reading={reading} />
      <ReadingDetails reading={reading} />
    </div>
  );
}
