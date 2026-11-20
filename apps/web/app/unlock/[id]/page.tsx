import type { Metadata } from "next";
import Link from "next/link";
import { PageShell } from "@/components/site-chrome";
import { PRICE_LABEL } from "@/lib/content";

export const metadata: Metadata = { title: "解锁报告", robots: { index: false } };

const DELIVERABLES = [
  "从你的处境出发的解读，每处解释都标明依据的原文编号",
  "需要你在现实中核实的信息",
  "一个七天内可以尝试的行动：做什么、什么时候前做、用什么反馈来判断",
  "回看条件，以及同一件事的三次追问",
  "跨设备回看、导出，可以随时删除",
];

export default async function UnlockPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <PageShell>
      <h1 className="font-serif text-2xl text-ink">解锁本次解读</h1>
      <p className="mt-2 text-sm text-ink-soft">一次付款 {PRICE_LABEL}，包含：</p>
      <ul className="mt-3 space-y-2 text-sm text-ink">
        {DELIVERABLES.map((d) => (
          <li key={d} className="flex gap-2">
            <span aria-hidden className="text-qing">
              ·
            </span>
            {d}
          </li>
        ))}
      </ul>
      <div className="mt-6 rounded-2xl border border-line bg-card p-5">
        <p className="font-medium text-ink">付费报告还在开发中，暂未开放购买。</p>
        <p className="mt-1 text-sm text-ink-soft">
          开放后，购买前会先请你用邮箱登录，并确认哪些内容会发送给模型服务方生成报告。
        </p>
      </div>
      <div className="mt-6 flex flex-wrap gap-4 text-sm">
        <Link href={`/r/${id}`} className="rounded-full bg-qing px-5 py-2 text-paper">
          返回本次结果
        </Link>
        <Link href="/samples/career" className="self-center text-qing underline underline-offset-4">
          先看看完整报告样例
        </Link>
      </div>
    </PageShell>
  );
}
