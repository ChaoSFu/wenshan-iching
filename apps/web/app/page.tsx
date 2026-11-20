import Image from "next/image";
import Link from "next/link";
import { QuestionStarter } from "@/components/question-starter";
import { OfferNote } from "@/components/offer-note";
import { topics } from "@/lib/content";

const STEPS = [
  { title: "写一件事", body: "选主题或直接写下问题，可补充一两项背景。" },
  { title: "三币起卦", body: "逐轮掷三枚钱币，从初爻画到上爻。" },
  { title: "读原文与简读", body: "看本卦、动爻与变卦，对照《周易》原文和白话。" },
  { title: "再决定是否解锁", body: `需要时购买一份结合处境的报告，含三次追问。` },
];

export default function HomePage() {
  const main = topics.filter((t) => t.id !== "other");
  const other = topics.find((t) => t.id === "other");

  return (
    <main>
      {/* 手机端：先露出提问入口，山水作为顶部画带；桌面端：标题叠在画面左侧留白处 */}
      <section className="relative">
        <div className="relative h-36 overflow-hidden sm:h-[360px]">
          <Image
            src="/images/shanshui.jpg"
            alt="青绿山水：云雾、远山、瀑布与松林"
            fill
            priority
            sizes="100vw"
            className="object-cover object-[78%_50%] sm:object-center"
          />
          <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-transparent to-paper" />
          <div className="absolute inset-y-0 left-0 hidden w-1/2 flex-col justify-center pl-[max(1rem,calc((100vw-64rem)/2+1rem))] sm:flex">
            <h1 className="font-serif text-5xl tracking-[0.3em] text-ink">问山</h1>
            <p className="mt-4 max-w-sm font-serif text-lg leading-8 text-ink-soft">
              以《周易》为本，问一件你正在关心的事。
            </p>
          </div>
        </div>

        <div className="mx-auto max-w-5xl px-4 sm:-mt-20">
          <div className="sm:hidden">
            <h1 className="font-serif text-3xl tracking-[0.25em] text-ink">问山</h1>
            <p className="mt-1 font-serif text-base text-ink-soft">以《周易》为本，问一件你正在关心的事。</p>
          </div>
          <div className="relative mt-4 sm:ml-auto sm:mt-0 sm:max-w-md">
            <QuestionStarter />
          </div>
        </div>
      </section>

      <section className="mx-auto mt-10 max-w-5xl px-4" aria-labelledby="topics-heading">
        <h2 id="topics-heading" className="font-serif text-xl text-ink">
          从一个主题开始
        </h2>
        <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {main.map((t) => (
            <li key={t.id}>
              <Link
                href={`/ask?topic=${t.id}`}
                className="group block h-full rounded-2xl border border-line bg-card p-4 transition-colors hover:border-qing/60 hover:bg-lu-soft/40"
              >
                <p className="font-serif text-lg text-ink group-hover:text-qing">{t.name}</p>
                <p className="mt-1 text-sm text-muted">{t.tagline}</p>
                <p className="mt-3 text-sm text-ink-soft">「{t.examples[0]}」</p>
              </Link>
            </li>
          ))}
        </ul>
        {other && (
          <Link
            href={`/ask?topic=${other.id}`}
            className="mt-3 flex items-center justify-between rounded-2xl border border-dashed border-line px-4 py-3 text-sm text-ink-soft transition-colors hover:border-qing/60 hover:text-qing"
          >
            <span>
              <span className="font-serif text-base text-ink">{other.name}</span>
              <span className="ml-2 text-muted">{other.tagline}</span>
            </span>
            <span aria-hidden>→</span>
          </Link>
        )}
      </section>

      <section className="mx-auto mt-12 max-w-5xl px-4" aria-labelledby="how-heading">
        <h2 id="how-heading" className="font-serif text-xl text-ink">
          怎么用
        </h2>
        <ol className="mt-4 grid gap-3 sm:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="rounded-2xl bg-paper-deep/60 p-4">
              <p className="font-serif text-sm text-zhu">{["一", "二", "三", "四"][i]}</p>
              <p className="mt-1 font-medium text-ink">{s.title}</p>
              <p className="mt-1 text-sm text-ink-soft">{s.body}</p>
            </li>
          ))}
        </ol>
        <OfferNote />
      </section>
    </main>
  );
}
