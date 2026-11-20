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
  | { id: string; type: "dispute.created"; paymentId: string }
  | { id: string; type: "ignored"; rawType: string };

export class WebhookSignatureError extends Error {
  override name = "WebhookSignatureError";
}

export interface PaymentProvider {
  readonly name: "stripe" | "fake";
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;
  retrieveCheckout(sessionId: string): Promise<CheckoutState>;
  /** 发起原路退款；succeeded 表示支付平台已确认，pending 表示等待回调 */
  refund(input: { paymentId: string; idempotencyKey: string }): Promise<{ status: "succeeded" | "pending" | "failed" }>;
  /** 校验签名并解析回调；签名不对时抛 WebhookSignatureError */
  parseWebhook(rawBody: string, headers: Headers): PaymentEvent;
}
