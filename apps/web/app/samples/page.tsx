import type { Metadata } from "next";
import Link from "next/link";
import { PageShell } from "@/components/site-chrome";
import { samplesBundle, topicById, topics } from "@/lib/content";

export const metadata: Metadata = {
  title: "解读样例",
  description: "同一卦（乾卦初九动，变姤）放在姻缘、事业、学业、收支和日常选择里，分别会给出怎样的下一步。",
};

export default function SamplesPage() {
  const ordered = topics.map((t) => samplesBundle.samples.find((s) => s.topic === t.id)).filter((s) => s !== undefined);
  return (
    <PageShell>
      <h1 className="font-serif text-2xl text-ink">解读样例</h1>
      <p className="mt-2 text-sm text-ink-soft">
        以下样例都用同一卦：乾卦初九动，变卦为姤。同一个观察角度——先准备、先试探——放进不同的处境，会得到不同的下一步。问题均为虚构。
      </p>
      <ul className="mt-6 space-y-3">
        {ordered.map((s) => (
          <li key={s.topic}>
            <Link
              href={`/samples/${s.topic}`}
              className="block rounded-2xl border border-line bg-card p-4 transition-colors hover:border-qing/60"
            >
              <p className="text-xs text-muted">
                {topicById(s.topic).name}
                {s.paid && <span className="ml-2 rounded bg-lu-soft px-1.5 py-0.5 text-qing">完整报告</span>}
              </p>
              <p className="mt-1 font-serif text-lg text-ink">{s.title}</p>
              <p className="mt-1 text-sm text-ink-soft">「{s.question}」</p>
            </Link>
          </li>
        ))}
      </ul>
    </PageShell>
  );
}
