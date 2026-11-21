/**
 * 支付服务抽象（技术方案 5.9）。生产用 Stripe Checkout；开发与测试用 fake，
 * 在本地模拟结账页、回调和退款，订单状态机走的是同一套代码。
 */

export interface CreateCheckoutInput {
  orderId: string;
  amountMinor: number;
  currency: string;
  email: string;
  description: string;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
}

export interface CheckoutSession {
  sessionId: string;
  url: string;
  expiresAt: Date;
}

export interface CheckoutState {
  sessionId: string;
  status: "open" | "complete" | "expired";
  paid: boolean;
  amountMinor: number | null;
  currency: string | null;
  paymentId: string | null;
  orderId: string | null;
}

/** 归一化后的支付事件；id 用于去重（防回调重放） */
export type PaymentEvent =
  | { id: string; type: "checkout.completed"; sessionId: string }
  | { id: string; type: "checkout.expired"; sessionId: string }
  /** amountRefundedMinor 是这笔付款累计已退金额，用来区分部分退款与整单退款 */
  | { id: string; type: "refund.succeeded"; paymentId: string; amountRefundedMinor: number; currency: string }
  /** 单笔退款的状态变化（含失败） */
  | { id: string; type: "refund.updated"; refundId: string; paymentId: string; status: ProviderRefundStatus; amountMinor: number; currency: string; failureReason: string | null }
  | { id: string; type: "dispute.created"; paymentId: string }
  | { id: string; type: "ignored"; rawType: string };

export type ProviderRefundStatus = "pending" | "succeeded" | "failed" | "canceled" | "requires_action";

export interface ProviderRefund {
  refundId: string;
  status: ProviderRefundStatus;
  amountMinor: number;
  currency: string;
  failureReason: string | null;
}

export class WebhookSignatureError extends Error {
  override name = "WebhookSignatureError";
}

export interface PaymentProvider {
  readonly name: "stripe" | "fake";
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;
  retrieveCheckout(sessionId: string): Promise<CheckoutState>;
  /** 发起原路退款（整单剩余金额）。同一幂等键重复调用返回同一笔退款 */
  refund(input: { paymentId: string; idempotencyKey: string }): Promise<ProviderRefund>;
  retrieveRefund(refundId: string): Promise<ProviderRefund>;
  /** 关闭仍可支付的结账；已经完成付款时返回 "already_complete" */
  expireCheckout(sessionId: string): Promise<"expired" | "already_complete" | "already_expired">;
  /** 校验签名并解析回调；签名不对时抛 WebhookSignatureError */
  parseWebhook(rawBody: string, headers: Headers): PaymentEvent;
}
