import Stripe from "stripe";
import { env } from "../env";
import {
  WebhookSignatureError,
  type CheckoutSession,
  type CheckoutState,
  type CreateCheckoutInput,
  type PaymentEvent,
  type PaymentProvider,
} from "./types";

// Stripe 要求至少 30 分钟；留 1 分钟余量，避免请求耗时导致被拒
const CHECKOUT_TTL_MS = 31 * 60_000;

export function createStripeProvider(): PaymentProvider {
  const stripe = new Stripe(env().STRIPE_SECRET_KEY ?? "");

  return {
    name: "stripe",

    async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
      const expiresAt = new Date(Date.now() + CHECKOUT_TTL_MS);
      const session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          client_reference_id: input.orderId,
          metadata: { order_id: input.orderId },
          payment_intent_data: { metadata: { order_id: input.orderId } },
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
          expires_at: Math.floor(expiresAt.getTime() / 1000),
          // 价格固定为美元（PRD §8）；关闭按本地货币展示，避免回调金额、币种与订单不一致
          adaptive_pricing: { enabled: false },
        },
        { idempotencyKey: input.idempotencyKey },
      );
      if (!session.url) throw new Error("Stripe returned a checkout session without url");
      return { sessionId: session.id, url: session.url, expiresAt };
    },

    async retrieveCheckout(sessionId: string): Promise<CheckoutState> {
      const s = await stripe.checkout.sessions.retrieve(sessionId);
      const paymentId = typeof s.payment_intent === "string" ? s.payment_intent : (s.payment_intent?.id ?? null);
      return {
        sessionId: s.id,
        status: s.status === "complete" ? "complete" : s.status === "expired" ? "expired" : "open",
        paid: s.payment_status === "paid",
        amountMinor: s.amount_total,
        currency: s.currency,
        paymentId,
        orderId: s.metadata?.order_id ?? s.client_reference_id ?? null,
      };
    },

    async refund({ paymentId, idempotencyKey }) {
      const refund = await stripe.refunds.create({ payment_intent: paymentId }, { idempotencyKey });
      return { status: refund.status === "succeeded" ? "succeeded" : refund.status === "failed" ? "failed" : "pending" };
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
          const pi = charge.payment_intent;
          const paymentId = typeof pi === "string" ? pi : pi?.id;
          return paymentId
            ? { id: event.id, type: "refund.succeeded", paymentId, amountRefundedMinor: charge.amount_refunded, currency: charge.currency }
            : { id: event.id, type: "ignored", rawType: event.type };
        }
        case "charge.dispute.created": {
          const pi = event.data.object.payment_intent;
          const paymentId = typeof pi === "string" ? pi : pi?.id;
          return paymentId ? { id: event.id, type: "dispute.created", paymentId } : { id: event.id, type: "ignored", rawType: event.type };
        }
        default:
          return { id: event.id, type: "ignored", rawType: event.type };
      }
    },
  };
}
