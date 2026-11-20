"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { composeFreeReading, contentGate, type CorpusBundle } from "@wenshan/content";
import { castFromTosses } from "@wenshan/iching-core";
import { ReadingView } from "@/components/reading-view";
import { loadCorpus, topicById, topicsBundle } from "@/lib/content";
import { useOffer } from "@/lib/offer";
import { loadReading, type StoredReading } from "@/lib/reading-store";
import { track } from "@/lib/track";

export function ResultView({ id }: { id: string }) {
  const [reading, setReading] = useState<StoredReading | null | undefined>(undefined);
  const [corpus, setCorpus] = useState<CorpusBundle | null>(null);
  const [loadError, setLoadError] = useState(false);
  const tracked = useRef(false);
  const offer = useOffer();

  useEffect(() => {
    setReading(loadReading(id));
    loadCorpus().then(setCorpus, () => setLoadError(true));
  }, [id]);

  const free = useMemo(() => {
    if (!reading || !corpus || reading.revealed < 6) return null;
    const cast = castFromTosses(reading.tosses);
    return composeFreeReading({ cast, topicId: reading.topicId, readingId: reading.id }, corpus, topicsBundle);
  }, [reading, corpus]);

  useEffect(() => {
    if (free && reading && !tracked.current) {
      tracked.current = true;
      track("result_viewed", { topic: reading.topicId, moving: free.movingLines.length });
    }
  }, [free, reading]);

  if (reading === undefined) return <p className="text-sm text-muted">正在恢复这一卦…</p>;
  if (reading === null) {
    return (
      <div className="space-y-3">
        <h1 className="font-serif text-2xl text-ink">找不到这一卦</h1>
        <p className="text-sm text-ink-soft">免费起卦只保存在原来的浏览器标签页里。如果关闭了标签页，需要重新写下问题。</p>
        <Link href="/ask" className="inline-block rounded-full bg-qing px-5 py-2 text-paper">
          重新开始
        </Link>
      </div>
    );
  }
  if (reading.revealed < 6) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-ink-soft">这一卦还没有画完。</p>
        <Link href={`/cast/${reading.id}`} className="inline-block rounded-full bg-qing px-5 py-2 text-paper">
          继续起卦
        </Link>
      </div>
    );
  }

  const topic = topicById(reading.topicId);

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs text-muted">{topic.name}</p>
        <h1 className="mt-1 font-serif text-xl leading-8 text-ink">「{reading.question}」</h1>
        <Link href={`/ask?reading=${reading.id}`} className="mt-1 inline-block text-sm text-qing underline underline-offset-4">
          修改问题或主题
        </Link>
      </header>

      {loadError && <p className="text-sm text-zhu">典籍内容加载失败，请检查网络后刷新页面。卦象不会改变。</p>}
      {!free && !loadError && <p className="text-sm text-muted">正在加载原文…</p>}
      {free && <ReadingView reading={free} topicName={topic.name} />}

      {free && (
        <section className="rounded-2xl border border-qing/40 bg-card p-5" aria-label="解锁报告">
          <p className="font-serif text-lg text-ink">想把这一卦和你的处境结合起来看？</p>
          <p className="mt-2 text-sm text-ink-soft">
            报告会从你的处境出发，列出需要核实的现实信息，给出一个七天内可以尝试的行动和回看条件，每处解释都标明依据的原文。
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
            {offer === undefined ? null : !offer?.salesEnabled ? (
              <p className="text-sm text-ink-soft">付费报告暂未开放。免费的卦象、原文与简读可以继续查看。</p>
            ) : free.missingEntries.length > 0 ||
              (offer.reviewRequired &&
                corpus &&
                !contentGate(castFromTosses(reading.tosses), reading.topicId, corpus, topicsBundle).ok) ? (
              <p className="text-sm text-ink-soft">这一卦的原文与注释仍在审校，暂时不能购买报告。</p>
            ) : (
              <>
                <Link
                  href={`/unlock/${reading.id}`}
                  onClick={() => track("unlock_clicked", { topic: reading.topicId })}
                  className="rounded-full bg-qing px-6 py-2.5 text-paper transition-colors hover:bg-qing-deep"
                >
                  解锁本次解读 · {offer.priceLabel}
                </Link>
                <p className="text-xs text-muted">一份报告、三次追问、支持回看和导出。一次付款。</p>
              </>
            )}
          </div>
        </section>
      )}

      <nav className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <Link href={`/samples/${reading.topicId}`} className="text-qing underline underline-offset-4">
          看看完整报告样例
        </Link>
        <Link href="/ask" className="text-muted hover:text-qing">
          换一件事
        </Link>
        <Link href="/rules" className="text-muted hover:text-qing">
          选文规则
        </Link>
      </nav>
    </div>
  );
}
