/**
 * 支付服务抽象（技术方案 5.9、附录 F）。生产用 Stripe Checkout；开发与测试用 fake，
 * 在本地模拟结账页、回调和退款，并按 Stripe 的幂等契约行事（同一幂等键配不同参数会被拒绝、
 * 结果被保存后重放返回同一个会话），订单状态机走的是同一套代码。
 */

/**
 * 创建 Checkout 的请求。除 email 外的全部字段都持久化在付款尝试里，
 * 同一尝试的重试原样重放（幂等键与参数一一对应）。
 */
export interface CreateCheckoutInput {
  orderId: string;
  /** 付款尝试 ID：写进支付方元数据，响应丢失时用它对账 */
  attemptId: string;
  amountMinor: number;
  currency: string;
  email: string;
  description: string;
  successUrl: string;
  cancelUrl: string;
  /** 请求里的有效期（稳定参数，不能在重试时重算） */
  expiresAt: Date;
  idempotencyKey: string;
}

export interface CheckoutSession {
  sessionId: string;
  url: string;
  /** 支付方返回的实际有效期 */
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
  /** 第三轮之后创建的会话带付款尝试 ID；旧会话为空 */
  attemptId: string | null;
  expiresAt: Date | null;
  url: string | null;
}

/**
 * 创建 Checkout 失败的分类：
 * - not_created：支付方明确没有创建会话（参数校验失败、鉴权失败等），可以开新尝试；
 * - unknown：结果不明（网络中断、5xx、限流、同一键的请求仍在处理），只能用同一键重放或对账；
 * - param_mismatch：同一幂等键配了不同参数（支付方拒绝），结果不明，只能对账。
 */
export class CheckoutCreateError extends Error {
  override name = "CheckoutCreateError";
  constructor(
    readonly kind: "not_created" | "unknown" | "param_mismatch",
    message: string,
  ) {
    super(message);
  }
}

/** 归一化后的支付事件；id 用于去重（防回调重放） */
export type PaymentEvent =
  | { id: string; type: "checkout.completed"; sessionId: string }
  | { id: string; type: "checkout.expired"; sessionId: string }
  /** 付款的累计退款发生变化（charge.refunded）：按支付方的退款列表重新入账 */
  | { id: string; type: "refund.succeeded"; paymentId: string; amountRefundedMinor: number; currency: string }
  /** 单笔退款的状态变化（含失败）；attemptId 来自退款元数据，外部发起的退款为空 */
  | {
      id: string;
      type: "refund.updated";
      refundId: string;
      paymentId: string;
      attemptId?: string | null;
      status: ProviderRefundStatus;
      amountMinor: number;
      currency: string;
      failureReason: string | null;
    }
  | { id: string; type: "dispute.created"; paymentId: string }
  | { id: string; type: "ignored"; rawType: string };

export type ProviderRefundStatus = "pending" | "succeeded" | "failed" | "canceled" | "requires_action";

export interface ProviderRefund {
  refundId: string;
  /** 被退款的付款（Stripe：payment_intent） */
  paymentId: string | null;
  /** 本系统发起的退款带退款记录 ID（元数据）；外部发起的为空 */
  attemptId: string | null;
  status: ProviderRefundStatus;
  amountMinor: number;
  currency: string;
  failureReason: string | null;
}

/** 发起退款被支付方明确拒绝（例如已全额退款）：没有产生退款 */
export class RefundRejectedError extends Error {
  override name = "RefundRejectedError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class WebhookSignatureError extends Error {
  override name = "WebhookSignatureError";
}

export interface PaymentProvider {
  readonly name: "stripe" | "fake";
  /** 失败时抛 CheckoutCreateError（其他异常按 unknown 处理） */
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;
  retrieveCheckout(sessionId: string): Promise<CheckoutState>;
  /** 按付款尝试 ID 找会话（创建响应丢失时对账）；查无此会话返回 null */
  findCheckout(q: { attemptId: string | null; orderId: string; createdAfter: Date }): Promise<CheckoutState | null>;
  /**
   * 发起原路退款（付款剩余金额）。同一幂等键重复调用返回同一笔退款。
   * attemptId 为空时不带元数据（迁移前发起的尝试按当时的参数重放）。
   * 支付方明确拒绝时抛 RefundRejectedError。
   */
  refund(input: { paymentId: string; idempotencyKey: string; attemptId: string | null; orderId: string }): Promise<ProviderRefund>;
  retrieveRefund(refundId: string): Promise<ProviderRefund>;
  /** 这笔付款在支付方的全部退款（按实际资金流水入账、核实未知结果） */
  listRefunds(paymentId: string): Promise<ProviderRefund[]>;
  /** 关闭仍可支付的结账；已经完成付款时返回 "already_complete" */
  expireCheckout(sessionId: string): Promise<"expired" | "already_complete" | "already_expired">;
  /** 校验签名并解析回调；签名不对时抛 WebhookSignatureError */
  parseWebhook(rawBody: string, headers: Headers): PaymentEvent;
}
