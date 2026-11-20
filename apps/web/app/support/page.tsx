import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageShell } from "@/components/site-chrome";
import { env } from "@/server/env";
import { SupportForm } from "./support-form";

export const metadata: Metadata = { title: "帮助与反馈" };
export const dynamic = "force-dynamic";

/** 产品客服集中在这里；人身安全求助在 /help */
export default function SupportPage() {
  const supportEmail = env().SUPPORT_EMAIL ?? null;
  return (
    <PageShell>
      <h1 className="font-serif text-2xl text-ink">帮助与反馈</h1>
      <p className="mt-2 text-sm text-ink-soft">
        付款、报告或页面遇到问题，都可以在这里告诉我们。提交后会得到一个工单号，请保存好。
        如果你或身边的人有人身安全方面的紧急情况，请看
        <Link href="/help" className="mx-1 text-qing underline underline-offset-4">
          求助指引
        </Link>
        。
      </p>
      <Suspense fallback={<p className="mt-6 text-sm text-muted">正在加载…</p>}>
        <SupportForm supportEmail={supportEmail} />
      </Suspense>
      {supportEmail && (
        <p className="mt-6 text-xs text-muted">
          网站无法正常提交时，也可以发邮件到 <a href={`mailto:${supportEmail}`} className="text-qing">{supportEmail}</a>，并附上订单号或工单号。
        </p>
      )}
    </PageShell>
  );
}
