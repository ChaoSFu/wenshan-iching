"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { LoginForm } from "@/components/login-form";
import { ApiError, STATUS_LABEL, api, formatDate, formatMoney, type OrderView } from "@/lib/api";

const POLLING: OrderView["status"][] = ["pending_payment", "paid", "generating", "refund_pending"];

/** 订单状态页（PRD §8「收款与交付」）：付款后在这里等报告，可关闭页面稍后回来 */
export function OrderStatus({ orderId }: { orderId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const fromCheckout = params.get("from") === "checkout";
  const [order, setOrder] = useState<OrderView | null>(null);
  const [state, setState] = useState<"loading" | "login" | "notfound" | "ok" | "error">("loading");
  const confirmed = useRef(false);

  const load = useCallback(async () => {
    try {
      // 从支付页回来时先主动核对一次，不只等 webhook
      const view =
        fromCheckout && !confirmed.current
          ? await api<OrderView>(`/api/orders/${orderId}/confirm`, { body: {} })
          : await api<OrderView>(`/api/orders/${orderId}`);
      confirmed.current = true;
      setOrder(view);
      setState("ok");
      if (view.status === "delivered" && view.reportId) router.replace(`/reports/${view.reportId}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setState("login");
      else if (err instanceof ApiError && err.status === 404) setState("notfound");
      else setState("error");
    }
  }, [orderId, fromCheckout, router]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!order || !POLLING.includes(order.status)) return;
    const t = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(t);
  }, [order, load]);

  if (state === "loading") return <p className="text-sm text-muted">正在查询订单…</p>;
  if (state === "login") return <LoginForm onDone={() => void load()} intro="登录后查看这笔订单与报告。" />;
  if (state === "notfound") return <p className="text-sm text-ink-soft">没有找到这笔订单。请确认登录的是购买时使用的邮箱。</p>;
  if (state === "error" || !order) {
    return (
      <p className="text-sm text-zhu">
        网络异常，暂时查不到订单状态。
        <button type="button" onClick={() => void load()} className="ml-2 text-qing underline underline-offset-4">
          重试
        </button>
      </p>
    );
  }

  const back = (
    <Link href={`/r/${order.clientReadingId}`} className="text-sm text-qing underline underline-offset-4">
      返回本次卦象
    </Link>
  );

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs text-muted">订单 {order.id.slice(0, 8)}</p>
        <h1 className="mt-1 font-serif text-2xl text-ink">{STATUS_LABEL[order.status]}</h1>
      </header>

      <section className="rounded-2xl border border-line bg-card p-5 text-sm text-ink-soft" aria-live="polite">
        {order.status === "pending_payment" && (
          <>
            <p>正在等待支付结果。如果你已经付款，这里会在几秒内更新。</p>
            <div className="mt-3 flex flex-wrap gap-4">
              {order.checkoutUrl && (
                <a href={order.checkoutUrl} className="rounded-full bg-qing px-5 py-2 text-paper">
                  继续支付
                </a>
              )}
              {back}
            </div>
          </>
        )}
        {order.status === "expired" && (
          <>
            <p>这次支付已取消或超时，没有扣款。</p>
            <div className="mt-3 flex flex-wrap gap-4">
              <Link href={`/unlock/${order.clientReadingId}`} className="rounded-full bg-qing px-5 py-2 text-paper">
                重新解锁
              </Link>
              {back}
            </div>
          </>
        )}
        {(order.status === "paid" || order.status === "generating") && (
          <>
            <p className="flex items-center gap-2 text-ink">
              <span aria-hidden className="inline-block h-2 w-2 animate-pulse rounded-full bg-qing" />
              已收到付款，正在生成报告，通常需要 30 秒左右。
            </p>
            <p className="mt-2">可以关闭页面，报告生成后会发邮件通知你，也可以随时从「我的报告」进入。</p>
          </>
        )}
        {order.status === "generation_failed" && (
          <p>
            报告生成遇到问题，我们正在处理，无需再次付款。
            {order.refundDueAt && `如果在 ${formatDate(order.refundDueAt)} 前仍未交付，会自动原路退款。`}
          </p>
        )}
        {order.status === "delivered" && <p>报告已生成，正在打开…</p>}
        {order.status === "refund_pending" && <p>正在原路退款 {formatMoney(order.amountMinor, order.currency)}，到账时间以支付机构为准。</p>}
        {order.status === "refunded" && (
          <>
            <p>
              已原路退款 {formatMoney(order.amountMinor, order.currency)}
              {order.refundedAt ? `（${formatDate(order.refundedAt)}）` : ""}。报告与追问已收回，免费卦象仍可查看。
            </p>
            <div className="mt-3">{back}</div>
          </>
        )}
        {order.status === "disputed" && <p>这笔付款存在支付争议，报告暂停访问。如有疑问请联系我们，并附上订单号。</p>}
      </section>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-muted">
        <dt>金额</dt>
        <dd>{formatMoney(order.amountMinor, order.currency)}</dd>
        <dt>下单时间</dt>
        <dd>{formatDate(order.createdAt)}</dd>
        {order.paidAt && (
          <>
            <dt>付款时间</dt>
            <dd>{formatDate(order.paidAt)}</dd>
          </>
        )}
        <dt>订单号</dt>
        <dd className="break-all">{order.id}</dd>
      </dl>
    </div>
  );
}
