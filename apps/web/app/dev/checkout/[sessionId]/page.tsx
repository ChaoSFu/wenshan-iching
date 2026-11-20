import { notFound } from "next/navigation";
import { PageShell } from "@/components/site-chrome";
import { env } from "@/server/env";
import { getFakeSession } from "@/server/payments/fake";
import { FakeCheckout } from "./fake-checkout";

export const dynamic = "force-dynamic";

/** 开发环境的模拟结账页（PAYMENT_PROVIDER=fake），生产环境不存在 */
export default async function DevCheckoutPage({ params }: { params: Promise<{ sessionId: string }> }) {
  if (env().NODE_ENV === "production" || env().PAYMENT_PROVIDER !== "fake") notFound();
  const { sessionId } = await params;
  const session = getFakeSession(sessionId);
  if (!session) notFound();
  const amount = `${session.currency.toUpperCase()} ${(session.amountMinor / 100).toFixed(2)}`;
  return (
    <PageShell>
      <p className="rounded-lg bg-zhu-soft px-3 py-2 text-xs text-zhu">开发环境 · 模拟支付页，不会产生真实扣款</p>
      <h1 className="mt-4 font-serif text-2xl text-ink">问山解读报告（含三次追问）</h1>
      <p className="mt-2 text-ink-soft">金额：{amount}</p>
      <FakeCheckout sessionId={sessionId} amount={amount} />
    </PageShell>
  );
}
