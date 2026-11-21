"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, api, formatDate } from "@/lib/api";
import { OrderExceptions } from "./order-exceptions";
import { ReleasePanel } from "./release-panel";

interface Ticket {
  id: string;
  ticketNo: string;
  categoryLabel: string;
  reportIssues: string[];
  status: "open" | "in_progress" | "resolved";
  description: string;
  contactEmail: string | null;
  orderId: string | null;
  orderStatus: string | null;
  reportId: string | null;
  reportVersions: Record<string, unknown> | null;
  question: string | null;
  diagnostics: Record<string, unknown>;
  notified: boolean;
  createdAt: string;
}

interface Costs {
  calls: number;
  transportFailures: number;
  totalUsd: number;
  unknownCostCalls: number;
  deliveredOrders: number;
  costPerDeliveryUsd: number | null;
  byKind: Record<
    string,
    { calls: number; usd: number; unknownCostCalls: number; inputTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number; avgLatencyMs: number }
  >;
  failures: Record<string, number>;
}

const STATUS = { open: "待处理", in_progress: "处理中", resolved: "已解决" } as const;
const ISSUE = { bad_citation: "引用有误", misunderstood: "误解题意", vague_action: "行动不具体" } as Record<string, string>;
const REFUNDABLE = new Set(["paid", "generating", "delivered", "generation_failed", "needs_review"]);

export function OpsConsole({ initialQuery }: { initialQuery: string }) {
  const [q, setQ] = useState(initialQuery);
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [costs, setCosts] = useState<Costs | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ q, category, status });
    setTickets((await api<{ tickets: Ticket[] }>(`/api/ops/tickets?${params}`)).tickets);
  }, [q, category, status]);

  useEffect(() => {
    void load();
    void api<Costs>("/api/ops/costs?days=30").then(setCosts, () => setCosts(null));
  }, [load]);

  async function setTicketStatus(id: string, s: Ticket["status"]) {
    await api(`/api/ops/tickets/${id}`, { method: "PATCH", body: { status: s } });
    await load();
  }

  async function refund(t: Ticket) {
    const reason = window.prompt(`确认为订单 ${t.orderId?.slice(0, 8)} 发起原路退款？请填写核实结论：`, `工单 ${t.ticketNo}`);
    if (!reason) return;
    try {
      await api(`/api/ops/orders/${t.orderId}/refund`, { body: { reason } });
      setMessage(`已为 ${t.ticketNo} 关联的订单发起退款`);
      await load();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "退款请求失败");
    }
  }

  return (
    <div className="space-y-8">
      <ReleasePanel />
      <OrderExceptions />
      <section>
        <h1 className="font-serif text-2xl text-ink">工单</h1>
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="工单号或订单号" className="rounded-lg border border-line bg-card px-3 py-1.5" />
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-lg border border-line bg-card px-2 py-1.5">
            <option value="">全部类型</option>
            <option value="duplicate_charge_or_refund">重复扣款或退款</option>
            <option value="paid_not_delivered">已付款未收到报告</option>
            <option value="login_or_page_error">登录或页面故障</option>
            <option value="report_content">报告内容问题</option>
            <option value="other">其他</option>
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-line bg-card px-2 py-1.5">
            <option value="">全部状态</option>
            <option value="open">待处理</option>
            <option value="in_progress">处理中</option>
            <option value="resolved">已解决</option>
          </select>
        </div>
        {message && <p className="mt-2 text-sm text-qing">{message}</p>}
        {tickets === null ? (
          <p className="mt-4 text-sm text-muted">正在加载…</p>
        ) : tickets.length === 0 ? (
          <p className="mt-4 text-sm text-muted">没有符合条件的工单。</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {tickets.map((t) => (
              <li key={t.id} className="rounded-2xl border border-line bg-card p-4 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p>
                    <span className="font-mono text-ink">{t.ticketNo}</span>
                    <span className="ml-2 text-muted">{t.categoryLabel}</span>
                    {t.reportIssues.map((i) => (
                      <span key={i} className="ml-2 rounded bg-zhu-soft px-1.5 text-xs text-zhu">
                        {ISSUE[i] ?? i}
                      </span>
                    ))}
                  </p>
                  <p className="text-xs text-muted">
                    {formatDate(t.createdAt)} · {t.notified ? "已通知运营邮箱" : "未发通知邮件"}
                  </p>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-ink">{t.description}</p>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted">
                  {t.contactEmail && (
                    <>
                      <dt>回复邮箱</dt>
                      <dd>{t.contactEmail}</dd>
                    </>
                  )}
                  {t.orderId && (
                    <>
                      <dt>订单</dt>
                      <dd>
                        {t.orderId}（{t.orderStatus}）
                      </dd>
                    </>
                  )}
                  {t.reportVersions && (
                    <>
                      <dt>报告版本</dt>
                      <dd>{Object.entries(t.reportVersions).map(([k, v]) => `${k} ${String(v)}`).join(" · ")}</dd>
                    </>
                  )}
                  <dt>诊断</dt>
                  <dd>{Object.entries(t.diagnostics).map(([k, v]) => `${k}=${String(v)}`).join(" · ")}</dd>
                  {t.question && (
                    <>
                      <dt>问题原文</dt>
                      <dd className="text-ink">{t.question}</dd>
                    </>
                  )}
                </dl>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {(Object.keys(STATUS) as Ticket["status"][]).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void setTicketStatus(t.id, s)}
                      className={`rounded-full border px-3 py-1 text-xs ${t.status === s ? "border-qing bg-qing text-paper" : "border-line text-ink-soft"}`}
                    >
                      {STATUS[s]}
                    </button>
                  ))}
                  {t.orderId && t.orderStatus && REFUNDABLE.has(t.orderStatus) && (
                    <button type="button" onClick={() => void refund(t)} className="ml-auto rounded-full border border-zhu/50 px-3 py-1 text-xs text-zhu">
                      核实后原路退款
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="font-serif text-xl text-ink">近 30 天模型成本</h2>
        {!costs ? (
          <p className="mt-2 text-sm text-muted">暂无数据</p>
        ) : (
          <div className="mt-2 text-sm text-ink-soft">
            <p>
              调用 {costs.calls} 次，已知成本合计 ${costs.totalUsd.toFixed(4)}
              {costs.unknownCostCalls > 0 ? `，另有 ${costs.unknownCostCalls} 次成本未知（价格表缺该模型或没有用量）` : ""}；成功交付{" "}
              {costs.deliveredOrders} 笔，每笔分摊{" "}
              {costs.costPerDeliveryUsd === null
                ? "—"
                : `$${costs.costPerDeliveryUsd.toFixed(4)}${costs.unknownCostCalls > 0 ? " 起" : ""}`}
              （含未购买用户的分流与失败重试）。
              {costs.transportFailures > 0 ? ` 网络或限流导致的重发 ${costs.transportFailures} 次（不计入调用次数）。` : ""}
            </p>
            <ul className="mt-2 space-y-1 text-xs">
              {Object.entries(costs.byKind).map(([k, v]) => (
                <li key={k}>
                  {k}：{v.calls} 次 · ${v.usd.toFixed(4)}
                  {v.unknownCostCalls > 0 ? `（${v.unknownCostCalls} 次成本未知）` : ""} · 输入 {v.inputTokens}（缓存 {v.cachedTokens}）· 输出 {v.outputTokens}（含推理 {v.reasoningTokens}）· 平均 {Math.round(v.avgLatencyMs)} ms
                </li>
              ))}
            </ul>
            {Object.keys(costs.failures).length > 0 && (
              <p className="mt-1 text-xs text-muted">失败原因：{Object.entries(costs.failures).map(([k, v]) => `${k} ${v}`).join("，")}</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
