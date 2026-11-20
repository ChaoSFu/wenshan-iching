"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  castFromTosses,
  lineInfo,
  lineValueOf,
  positionName,
  type Coin,
  type Toss,
} from "@wenshan/iching-core";
import { HexagramFigure } from "@/components/hexagram-figure";
import { loadCorpus, topicById } from "@/lib/content";
import { loadReading, loadSkipAnimation, saveReading, saveSkipAnimation, type StoredReading } from "@/lib/reading-store";
import { track } from "@/lib/track";

const FLIP_MS = 700;

function CoinFace({ value, spinning }: { value: Coin | null; spinning: boolean }) {
  const heads = value === 3;
  return (
    <span
      aria-label={value === null ? "钱币" : heads ? "正面，记 3" : "反面，记 2"}
      className={`relative flex h-12 w-12 items-center justify-center rounded-full border-2 font-serif text-lg shadow-sm [transform-style:preserve-3d] sm:h-14 sm:w-14 ${
        spinning ? "animate-coin border-line bg-card text-muted" : heads ? "border-qing bg-qing text-paper" : "border-ink/30 bg-card text-ink"
      }`}
    >
      <span aria-hidden className="absolute h-3.5 w-3.5 rounded-[2px] border border-current opacity-40" />
      <span aria-hidden className="relative">{spinning || value === null ? "" : heads ? "正" : "反"}</span>
    </span>
  );
}

function RoundRow({ index, toss }: { index: number; toss: Toss }) {
  const v = lineValueOf(toss);
  const info = lineInfo(v);
  return (
    <li className="flex items-center justify-between gap-3 border-b border-line/60 py-2 text-sm last:border-0">
      <span className="w-12 font-serif text-ink">{positionName(index + 1)}</span>
      <span className="flex-1 text-muted">{toss.map((c) => (c === 3 ? "正" : "反")).join(" · ")}</span>
      <span className="w-8 text-right tabular-nums text-ink-soft">{v}</span>
      <span className="w-10 text-ink">{info.name}</span>
      <span className={`w-6 text-right font-serif ${info.moving ? "text-zhu" : "text-muted"}`}>{info.moving ? "动" : "静"}</span>
    </li>
  );
}

export function CastView({ id }: { id: string }) {
  const router = useRouter();
  const [reading, setReading] = useState<StoredReading | null | undefined>(undefined);
  const [spinning, setSpinning] = useState(false);
  const [skipAnimation, setSkipAnimation] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setReading(loadReading(id));
    setSkipAnimation(loadSkipAnimation());
    // 动画期间预先加载典籍内容包，结果页可以立即显示（PRD §9：2 秒内可用）
    void loadCorpus();
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [id]);

  if (reading === undefined) return <p className="text-sm text-muted">正在恢复这一卦…</p>;
  if (reading === null) {
    return (
      <div className="space-y-3">
        <h1 className="font-serif text-2xl text-ink">找不到这一卦</h1>
        <p className="text-sm text-ink-soft">起卦记录只保存在原来的浏览器标签页里。如果关闭了标签页，需要重新写下问题。</p>
        <Link href="/ask" className="inline-block rounded-full bg-qing px-5 py-2 text-paper">
          重新开始
        </Link>
      </div>
    );
  }

  const current = reading;
  const topic = topicById(current.topicId);
  const done = current.revealed >= 6;
  const cast = castFromTosses(current.tosses);
  const lastToss = current.revealed > 0 ? current.tosses[current.revealed - 1] : null;

  function update(revealed: number) {
    const next = { ...current, revealed };
    saveReading(next);
    setReading(next);
    if (revealed === 1) track("cast_started", { topic: next.topicId });
    if (revealed >= 6) track("cast_completed", { topic: next.topicId, moving: cast.movingLines.length });
  }

  function throwOnce() {
    if (spinning || done) return;
    if (skipAnimation) {
      update(current.revealed + 1);
      return;
    }
    setSpinning(true);
    timer.current = window.setTimeout(() => {
      setSpinning(false);
      update(current.revealed + 1);
    }, FLIP_MS);
  }

  function finishAll() {
    if (timer.current) window.clearTimeout(timer.current);
    setSpinning(false);
    update(6);
  }

  function toggleSkip(v: boolean) {
    setSkipAnimation(v);
    saveSkipAnimation(v);
  }

  const nextPosition = Math.min(current.revealed + 1, 6);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-muted">{topic.name}</p>
        <h1 className="mt-1 font-serif text-xl leading-8 text-ink">「{current.question}」</h1>
      </div>

      <section className="rounded-2xl border border-line bg-card p-5" aria-live="polite">
        <div className="flex items-start justify-between gap-3 sm:gap-6">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-muted">
              {done ? "六爻已成" : `第 ${nextPosition} 轮 · ${positionName(nextPosition)}`}
            </p>
            <div className="mt-4 flex gap-2 sm:gap-3">
              {[0, 1, 2].map((i) => (
                <CoinFace key={`${current.revealed}-${i}`} spinning={spinning} value={spinning ? null : (lastToss?.[i] ?? null)} />
              ))}
            </div>
            {lastToss && !spinning && (
              <p className="mt-3 text-sm text-ink-soft">
                {positionName(current.revealed)}：合计 {lineValueOf(lastToss)}，{lineInfo(lineValueOf(lastToss)).name}
                {lineInfo(lineValueOf(lastToss)).moving ? "，动爻" : ""}
              </p>
            )}
          </div>
          <HexagramFigure
            bits={cast.lines.map((v) => (lineInfo(v).yang ? 1 : 0))}
            moving={cast.movingLines}
            revealed={current.revealed}
            size="md"
            label={`已画出 ${current.revealed} 爻`}
          />
        </div>

        {!done ? (
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={throwOnce}
              disabled={spinning}
              className="rounded-full bg-qing px-6 py-2.5 text-paper transition-colors hover:bg-qing-deep disabled:opacity-60"
            >
              掷{positionName(nextPosition)}
            </button>
            <button type="button" onClick={finishAll} className="rounded-full border border-qing/60 px-5 py-2.5 text-qing">
              一次完成
            </button>
            <label className="ml-auto flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={skipAnimation} onChange={(e) => toggleSkip(e.target.checked)} className="accent-qing" />
              跳过动画
            </label>
          </div>
        ) : (
          <div className="mt-6">
            <button
              type="button"
              onClick={() => router.push(`/r/${current.id}`)}
              className="rounded-full bg-qing px-6 py-2.5 text-paper transition-colors hover:bg-qing-deep"
            >
              查看卦象与原文
            </button>
          </div>
        )}
      </section>

      {current.revealed > 0 && (
        <section>
          <h2 className="text-sm font-medium text-ink">每一轮的结果</h2>
          <ol className="mt-2 rounded-2xl border border-line bg-card px-4">
            {current.tosses.slice(0, current.revealed).map((t, i) => (
              <RoundRow key={i} index={i} toss={t} />
            ))}
          </ol>
        </section>
      )}

      <details className="rounded-2xl bg-paper-deep/60 p-4 text-sm text-ink-soft">
        <summary className="cursor-pointer font-medium text-ink">起卦规则</summary>
        <p className="mt-2">
          每轮掷三枚钱币，正面记 3，反面记 2，三枚相加得到一爻：6 老阴（动）、7 少阳、8 少阴、9 老阳（动）。六轮从下往上，依次画出初爻到上爻。
        </p>
        <p className="mt-2">
          六轮钱币在你点「开始起卦」时已经一次抽好；逐轮显示和「一次完成」看到的是同一批结果，刷新页面也不会改变。
          <Link href="/rules" className="ml-1 text-qing underline underline-offset-4">
            完整规则
          </Link>
        </p>
      </details>
    </div>
  );
}
