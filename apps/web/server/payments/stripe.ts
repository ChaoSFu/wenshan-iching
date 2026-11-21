import Stripe from "stripe";
import { env } from "../env";
import {
  CheckoutCreateError,
  RefundRejectedError,
  WebhookSignatureError,
  type CheckoutSession,
  type CheckoutState,
  type CreateCheckoutInput,
  type PaymentEvent,
  type PaymentProvider,
  type ProviderRefund,
  type ProviderRefundStatus,
} from "./types";

/** 对账时最多翻多少个会话（只看付款尝试创建前后的时间窗） */
const FIND_SCAN_LIMIT = 1000;

const idOf = (x: string | { id: string } | null | undefined): string | null => (typeof x === "string" ? x : (x?.id ?? null));

function toRefund(r: Stripe.Refund): ProviderRefund {
  const status: ProviderRefundStatus =
    r.status === "succeeded" || r.status === "failed" || r.status === "canceled" || r.status === "requires_action" ? r.status : "pending";
  return {
    refundId: r.id,
    paymentId: idOf(r.payment_intent),
    attemptId: r.metadata?.refund_attempt_id ?? null,
    status,
    amountMinor: r.amount,
    currency: r.currency,
    failureReason: r.failure_reason ?? null,
  };
}

function toState(s: Stripe.Checkout.Session): CheckoutState {
  return {
    sessionId: s.id,
    status: s.status === "complete" ? "complete" : s.status === "expired" ? "expired" : "open",
    paid: s.payment_status === "paid",
    amountMinor: s.amount_total,
    currency: s.currency,
    paymentId: idOf(s.payment_intent),
    orderId: s.metadata?.order_id ?? s.client_reference_id ?? null,
    attemptId: s.metadata?.attempt_id ?? null,
    expiresAt: s.expires_at ? new Date(s.expires_at * 1000) : null,
    url: s.url ?? null,
  };
}

/**
 * Stripe 的错误按"会话是否可能已被创建"分类（附录 F.1）：
 * - idempotency_error：同一键配了不同参数，原请求的结果不明；
 * - 连接错误、5xx、429、409（同一键的请求仍在处理）：结果不明，同一键重放；
 * - 其他 4xx：端点没有创建会话（参数校验失败的结果不会被保存，可以安全地换新尝试）。
 */
function classifyCheckoutError(err: unknown): CheckoutCreateError {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof Stripe.errors.StripeIdempotencyError) return new CheckoutCreateError("param_mismatch", message);
  if (err instanceof Stripe.errors.StripeConnectionError || err instanceof Stripe.errors.StripeAPIError || err instanceof Stripe.errors.StripeRateLimitError) {
    return new CheckoutCreateError("unknown", message);
  }
  if (err instanceof Stripe.errors.StripeError) {
    const status = err.statusCode ?? 0;
    if (status === 409 || status === 429 || status >= 500 || status === 0) return new CheckoutCreateError("unknown", message);
    return new CheckoutCreateError("not_created", message);
  }
  return new CheckoutCreateError("unknown", message);
}

export function createStripeProvider(): PaymentProvider {
  const stripe = new Stripe(env().STRIPE_SECRET_KEY ?? "");

  return {
    name: "stripe",

    async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
      let session: Stripe.Checkout.Session;
      try {
        session = await stripe.checkout.sessions.create(
          {
            mode: "payment",
            client_reference_id: input.orderId,
            metadata: { order_id: input.orderId, attempt_id: input.attemptId },
            payment_intent_data: { metadata: { order_id: input.orderId, attempt_id: input.attemptId } },
            customer_email: input.email,
            line_items: [
              {
                quantity: 1,
                price_data: {
                  currency: input.currency,
                  unit_amount: input.amountMinor,
                  product_data: { name: input.description },
                },
              },
            ],
            success_url: input.successUrl,
            cancel_url: input.cancelUrl,
            // 付款尝试里持久化的有效期：重试原样发送，幂等键与参数保持一致
            expires_at: Math.floor(input.expiresAt.getTime() / 1000),
            // 价格固定为美元（PRD §8）；关闭按本地货币展示，避免回调金额、币种与订单不一致
            adaptive_pricing: { enabled: false },
          },
          { idempotencyKey: input.idempotencyKey },
        );
      } catch (err) {
        throw classifyCheckoutError(err);
      }
      if (!session.url) throw new CheckoutCreateError("unknown", "Stripe returned a checkout session without url");
      return { sessionId: session.id, url: session.url, expiresAt: new Date(session.expires_at * 1000) };
    },

    async retrieveCheckout(sessionId: string): Promise<CheckoutState> {
      return toState(await stripe.checkout.sessions.retrieve(sessionId));
    },

    async findCheckout({ attemptId, orderId, createdAfter }) {
      let scanned = 0;
      // 列表按创建时间倒序；只看付款尝试创建前一分钟之后的会话
      for await (const s of stripe.checkout.sessions.list({ created: { gte: Math.floor(createdAfter.getTime() / 1000) - 60 }, limit: 100 })) {
        const matches = attemptId
          ? s.metadata?.attempt_id === attemptId
          : !s.metadata?.attempt_id && (s.metadata?.order_id === orderId || s.client_reference_id === orderId);
        if (matches) return toState(s);
        if (++scanned >= FIND_SCAN_LIMIT) break;
      }
      return null;
    },

    async refund({ paymentId, idempotencyKey, attemptId, orderId }) {
      try {
        const params: Stripe.RefundCreateParams = { payment_intent: paymentId };
        // 迁移前发起的尝试按当时的参数重放（不带元数据），否则同一幂等键会被拒绝
        if (attemptId) params.metadata = { order_id: orderId, refund_attempt_id: attemptId };
        return toRefund(await stripe.refunds.create(params, { idempotencyKey }));
      } catch (err) {
        if (err instanceof Stripe.errors.StripeInvalidRequestError && !(err instanceof Stripe.errors.StripeIdempotencyError)) {
          const status = err.statusCode ?? 0;
          if (status >= 400 && status < 500 && status !== 409 && status !== 429) throw new RefundRejectedError(err.code ?? "invalid_request", err.message);
        }
        throw err;
      }
    },

    async retrieveRefund(refundId) {
      return toRefund(await stripe.refunds.retrieve(refundId));
    },

    async listRefunds(paymentId) {
      const out: ProviderRefund[] = [];
      for await (const r of stripe.refunds.list({ payment_intent: paymentId, limit: 100 })) {
        out.push(toRefund(r));
        if (out.length >= 500) break;
      }
      return out;
    },

    async expireCheckout(sessionId) {
      const s = await stripe.checkout.sessions.retrieve(sessionId);
      if (s.status === "complete") return "already_complete";
      if (s.status === "expired") return "already_expired";
      try {
        await stripe.checkout.sessions.expire(sessionId);
      } catch (err) {
        // 关闭时恰好被付款或已过期：以支付方当前状态为准
        const again = await stripe.checkout.sessions.retrieve(sessionId);
        if (again.status === "complete") return "already_complete";
        if (again.status === "expired") return "already_expired";
        throw err;
      }
      return "expired";
    },

    parseWebhook(rawBody: string, headers: Headers): PaymentEvent {
      const signature = headers.get("stripe-signature");
      if (!signature) throw new WebhookSignatureError("missing stripe-signature");
      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(rawBody, signature, env().STRIPE_WEBHOOK_SECRET ?? "");
      } catch (err) {
        throw new WebhookSignatureError((err as Error).message);
      }
      switch (event.type) {
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded":
          return { id: event.id, type: "checkout.completed", sessionId: event.data.object.id };
        case "checkout.session.expired":
          return { id: event.id, type: "checkout.expired", sessionId: event.data.object.id };
        case "charge.refunded": {
          const charge = event.data.object;
          const paymentId = idOf(charge.payment_intent);
          return paymentId
            ? { id: event.id, type: "refund.succeeded", paymentId, amountRefundedMinor: charge.amount_refunded, currency: charge.currency }
            : { id: event.id, type: "ignored", rawType: event.type };
        }
        case "refund.created":
        case "refund.updated":
        case "refund.failed": {
          const t = toRefund(event.data.object);
          if (!t.paymentId) return { id: event.id, type: "ignored", rawType: event.type };
          return {
            id: event.id,
            type: "refund.updated",
            refundId: t.refundId,
            paymentId: t.paymentId,
            attemptId: t.attemptId,
            status: t.status,
            amountMinor: t.amountMinor,
            currency: t.currency,
            failureReason: t.failureReason,
          };
        }
        case "charge.dispute.created": {
          const paymentId = idOf(event.data.object.payment_intent);
          return paymentId ? { id: event.id, type: "dispute.created", paymentId } : { id: event.id, type: "ignored", rawType: event.type };
        }
        default:
          return { id: event.id, type: "ignored", rawType: event.type };
      }
    },
  };
}
