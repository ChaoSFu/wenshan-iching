"use client";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** 调用本站 API；错误统一转成 ApiError（带服务端的错误码与中文说明） */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string; details?: unknown };
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? "请求失败，请稍后再试", data.details);
  return data as T;
}

export interface Me {
  user: { email: string } | null;
}

export type OrderStatus =
  | "pending_payment"
  | "expired"
  | "paid"
  | "generating"
  | "delivered"
  | "generation_failed"
  | "refund_pending"
  | "refunded"
  | "disputed"
  | "needs_review"
  | "refund_failed";

export interface OrderView {
  id: string;
  status: OrderStatus;
  amountMinor: number;
  currency: string;
  createdAt: string;
  paidAt: string | null;
  deliveredAt: string | null;
  refundDueAt: string | null;
  refundedAt: string | null;
  failureReason: string | null;
  reviewReason: string | null;
  /** 支付方确认的实收（旧单未核实为空） */
  paidAmountMinor: number | null;
  paidCurrency: string | null;
  /** 支付方确认的已成功退款合计 */
  refundedAmountMinor: number;
  refundedCurrency: string | null;
  checkoutUrl: string | null;
  reportId: string | null;
  clientReadingId: string;
  followupsRemaining: number;
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  pending_payment: "待支付",
  expired: "已取消",
  paid: "已支付，等待生成",
  generating: "正在生成",
  delivered: "已交付",
  generation_failed: "生成异常",
  refund_pending: "正在退款",
  refunded: "已退款",
  disputed: "支付争议",
  needs_review: "正在核实",
  refund_failed: "退款处理中",
};

export function formatMoney(amountMinor: number, currency: string): string {
  return currency.toLowerCase() === "usd" ? `US$${(amountMinor / 100).toFixed(2)}` : `${(amountMinor / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
