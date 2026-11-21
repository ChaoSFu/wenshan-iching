"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, api, formatDate, formatMoney } from "@/lib/api";

interface Exception {
  id: string;
  status: string;
  reviewReason: string | null;
  failureReason: string | null;
  amountMinor: number;
  currency: string;
  refundedAmountMinor: number;
  generationCalls: number;
  updatedAt: string;
  refunds: { attemptNo: number; status: string; amountMinor: number | null; failureReason: string | null; requestedBy: string; updatedAt: string }[];
  lastGeneration: { status: string; failureReason: string | null; createdAt: string } | null;
  actions: { actor: string; action: string; result: string; createdAt: string }[];
}

/** 订单异常：不需要用户先提工单，异常单自动出现在这里 */
export function OrderExceptions() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Exception[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRows((await api<{ orders: Exception[] }>(`/api/ops/orders?q=${encodeURIComponent(q)}`)).orders);
  }, [q]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, path: "refund" | "retry-refund" | "requeue", label: string) {
    const note = window.prompt(`${label}：请填写核实结论`, "");
    if (!note) return;
    try {
      const res = await api<{ message?: string }>(`/api/ops/orders/${id}/${path}`, { body: path === "refund" ? { reason: note } : { note } });
      setMessage(res.message ?? `${label}已提交`);
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : `${label}失败`);
    }
    await load();
  }

  return (
    <section>
      <h2 className="font-serif text-xl text-ink">订单异常</h2>
      <p className="mt-1 text-xs text-muted">待核实、退款失败、超过 1 小时未完成的退款、生成异常、部分退款。</p>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="订单号（前缀即可）" className="mt-3 rounded-lg border border-line bg-card px-3 py-1.5 text-sm" />
      {message && <p className="mt-2 text-sm text-qing">{message}</p>}
      {rows === null ? (
        <p className="mt-3 text-sm text-muted">正在加载…</p>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted">没有异常订单。</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {rows.map((o) => (
            <li key={o.id} className="rounded-2xl border border-zhu/30 bg-card p-4 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p>
                  <span className="font-mono text-ink">{o.id}</span>
                  <span className="ml-2 rounded bg-zhu-soft px-1.5 text-xs text-zhu">{o.status}</span>
                  {o.reviewReason && <span className="ml-2 text-xs text-muted">{o.reviewReason}</span>}
                </p>
                <p className="text-xs text-muted">更新于 {formatDate(o.updatedAt)}</p>
              </div>
              <p className="mt-1 text-xs text-ink-soft">
                金额 {formatMoney(o.amountMinor, o.currency)} · 已退 {formatMoney(o.refundedAmountMinor, o.currency)} · 生成调用 {o.generationCalls} 次
                {o.failureReason ? ` · 原因 ${o.failureReason}` : ""}
              </p>
              {o.refunds.length > 0 && (
                <ul className="mt-1 text-xs text-muted">
                  {o.refunds.map((r) => (
                    <li key={r.attemptNo}>
                      退款第 {r.attemptNo} 次：{r.status}
                      {r.amountMinor !== null ? ` ${formatMoney(r.amountMinor, o.currency)}` : ""}
                      {r.failureReason ? ` · ${r.failureReason}` : ""} · {r.requestedBy} · {formatDate(r.updatedAt)}
                    </li>
                  ))}
                </ul>
              )}
              {o.lastGeneration && (
                <p className="mt-1 text-xs text-muted">
                  最近一次生成：{o.lastGeneration.status}
                  {o.lastGeneration.failureReason ? `（${o.lastGeneration.failureReason}）` : ""}
                </p>
              )}
              {o.actions.length > 0 && (
                <ul className="mt-1 text-xs text-muted">
                  {o.actions.map((a, i) => (
                    <li key={i}>
                      {formatDate(a.createdAt)} · {a.actor} · {a.action} → {a.result}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                {o.status === "refund_failed" && (
                  <button type="button" onClick={() => void act(o.id, "retry-refund", "核实后重试退款")} className="rounded-full border border-zhu/50 px-3 py-1 text-xs text-zhu">
                    核实后重试退款
                  </button>
                )}
                {["needs_review", "generation_failed", "delivered"].includes(o.status) && (
                  <button type="button" onClick={() => void act(o.id, "refund", "原路退款")} className="rounded-full border border-zhu/50 px-3 py-1 text-xs text-zhu">
                    原路退款
                  </button>
                )}
                {["needs_review", "generation_failed"].includes(o.status) && o.reviewReason !== "amount_mismatch" && (
                  <button type="button" onClick={() => void act(o.id, "requeue", "重新生成")} className="rounded-full border border-line px-3 py-1 text-xs text-ink-soft">
                    重新生成
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
