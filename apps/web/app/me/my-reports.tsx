"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { LoginForm } from "@/components/login-form";
import { STATUS_LABEL, api, formatDate, formatMoney, type Me, type OrderView } from "@/lib/api";

export function MyReports() {
  const [me, setMe] = useState<Me["user"] | undefined>(undefined);
  const [orders, setOrders] = useState<OrderView[] | null>(null);

  const load = useCallback(async () => {
    const res = await api<Me>("/api/me");
    setMe(res.user);
    if (res.user) setOrders((await api<{ orders: OrderView[] }>("/api/me/orders")).orders);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function logout() {
    await api("/api/auth/logout", { body: {} });
    setMe(null);
    setOrders(null);
  }

  if (me === undefined) return <p className="text-sm text-muted">正在加载…</p>;
  if (me === null) return <LoginForm onDone={() => void load()} intro="用购买时的邮箱登录，查看你的报告。" />;

  return (
    <div className="space-y-5">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="font-serif text-2xl text-ink">我的报告</h1>
        <button type="button" onClick={() => void logout()} className="text-sm text-muted hover:text-qing">
          退出 {me.email}
        </button>
      </header>
      {orders === null ? (
        <p className="text-sm text-muted">正在加载…</p>
      ) : orders.length === 0 ? (
        <p className="text-sm text-ink-soft">
          还没有报告。
          <Link href="/ask" className="ml-1 text-qing underline underline-offset-4">
            去起一卦
          </Link>
        </p>
      ) : (
        <ul className="space-y-3">
          {orders.map((o) => (
            <li key={o.id}>
              <Link
                href={o.reportId ? `/reports/${o.reportId}` : `/orders/${o.id}`}
                className="block rounded-2xl border border-line bg-card p-4 transition-colors hover:border-qing/60"
              >
                <p className="flex justify-between text-sm">
                  <span className="text-ink">{STATUS_LABEL[o.status]}</span>
                  <span className="text-muted">{formatMoney(o.amountMinor, o.currency)}</span>
                </p>
                <p className="mt-1 text-xs text-muted">
                  {formatDate(o.createdAt)}
                  {o.status === "delivered" && ` · 剩余追问 ${o.followupsRemaining} 次`}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted">为保护隐私，列表不显示问题内容，点开后可查看。</p>
    </div>
  );
}
