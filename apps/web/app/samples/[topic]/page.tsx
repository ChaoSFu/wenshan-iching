import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import corpusJson from "@wenshan/content/generated/corpus.json";
import { TOPIC_IDS, composeFreeReading, type CorpusBundle } from "@wenshan/content";
import { castFromTosses, tossesFromLines } from "@wenshan/iching-core";
import { ReadingView } from "@/components/reading-view";
import { PageShell } from "@/components/site-chrome";
import { PRICE_LABEL, isTopicId, samplesBundle, topicById, topicsBundle } from "@/lib/content";

const corpus = corpusJson as unknown as CorpusBundle;

export function generateStaticParams() {
  return TOPIC_IDS.map((topic) => ({ topic }));
}

export async function generateMetadata({ params }: { params: Promise<{ topic: string }> }): Promise<Metadata> {
  const { topic } = await params;
  if (!isTopicId(topic)) return {};
  return { title: `${topicById(topic).name}样例` };
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-card p-5">
      <h3 className="text-xs text-muted">{title}</h3>
      <div className="mt-2 text-[15px] leading-7 text-ink">{children}</div>
    </section>
  );
}

export default async function SamplePage({ params }: { params: Promise<{ topic: string }> }) {
  const { topic: topicParam } = await params;
  if (!isTopicId(topicParam)) notFound();
  const sample = samplesBundle.samples.find((s) => s.topic === topicParam);
  if (!sample) notFound();

  const topic = topicById(sample.topic);
  const cast = castFromTosses(tossesFromLines(sample.lines));
  const reading = composeFreeReading({ cast, topicId: sample.topic, readingId: `sample-${sample.topic}` }, corpus, topicsBundle);

  return (
    <PageShell>
      <p className="text-xs text-muted">
        样例 · {topic.name} · 虚构问题
      </p>
      <h1 className="mt-1 font-serif text-2xl text-ink">{sample.title}</h1>
      <blockquote className="mt-3 border-l-2 border-lu pl-4 font-serif text-lg leading-8 text-ink-soft">
        「{sample.question}」
      </blockquote>

      <h2 className="mt-8 mb-3 text-sm font-medium text-ink">免费可读</h2>
      <ReadingView reading={reading} topicName={topic.name} />

      <h2 className="mt-10 mb-3 text-sm font-medium text-ink">
        {sample.paid ? `解锁后可读（${PRICE_LABEL}）` : "结合主题给出的下一步"}
      </h2>
      {sample.paid ? (
        <div className="space-y-3">
          <Block title="处境">{sample.paid.situation}</Block>
          <Block title="结合问题看卦">
            <p>{sample.paid.observation}</p>
            <ul className="mt-3 space-y-1 text-sm text-ink-soft">
              {sample.paid.observationCitations.map((id) => {
                const e = corpus.entries[id];
                if (!e) return null;
                const hex = corpus.hexagrams[String(e.hexagram)];
                return (
                  <li key={id} className="font-serif">
                    <span className="mr-2 font-sans text-xs text-muted">{id}</span>「{hex?.name}」{e.label && e.kind !== "gua" ? e.label : ""}
                    {e.kind === "tuan" ? "彖传" : ""}：{e.text}
                  </li>
                );
              })}
            </ul>
          </Block>
          <Block title="需要核实">{sample.paid.toVerify}</Block>
          <Block title="七天行动">{sample.paid.sevenDayAction}</Block>
          <Block title="一个追问示例">{sample.paid.followupExample}</Block>
        </div>
      ) : (
        <Block title={topic.name}>{sample.nextStep}</Block>
      )}

      <div className="mt-8 flex flex-wrap gap-4 text-sm">
        <Link href={`/ask?topic=${sample.topic}`} className="rounded-full bg-qing px-5 py-2 text-paper">
          问我自己的事
        </Link>
        <Link href="/samples" className="self-center text-qing underline underline-offset-4">
          其他主题的样例
        </Link>
      </div>
    </PageShell>
  );
}
