import { createHmac, randomUUID } from "node:crypto";
import { env } from "../env";
import {
  WebhookSignatureError,
  type CheckoutSession,
  type CheckoutState,
  type PaymentEvent,
  type PaymentProvider,
} from "./types";

/**
 * 本地替身：结账页是 /dev/checkout/[sessionId]，点"模拟支付成功"后生成一个
 * 带签名的回调事件，交给与 Stripe 相同的处理流程。只在非生产环境可用。
 */

interface FakeSession {
  sessionId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  status: "open" | "complete" | "expired";
  paymentId: string | null;
  expiresAt: Date;
  successUrl: string;
  cancelUrl: string;
}

const g = globalThis as unknown as { __fakeCheckouts?: Map<string, FakeSession>; __fakeIdem?: Map<string, string> };
const sessions = (g.__fakeCheckouts ??= new Map());
const idempotency = (g.__fakeIdem ??= new Map());

const SECRET = "fake-webhook-secret";

export function signFakeEvent(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

export function getFakeSession(sessionId: string): FakeSession | undefined {
  return sessions.get(sessionId);
}

/** 模拟用户在结账页付款成功，返回对应的回调请求体 */
export function completeFakeCheckout(sessionId: string): { body: string; signature: string } {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("unknown fake session");
  s.status = "complete";
  s.paymentId ??= `fake_pi_${randomUUID()}`;
  const body = JSON.stringify({ id: `fake_evt_${randomUUID()}`, type: "checkout.completed", sessionId });
  return { body, signature: signFakeEvent(body) };
}

export function expireFakeCheckout(sessionId: string): { body: string; signature: string } {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("unknown fake session");
  s.status = "expired";
  const body = JSON.stringify({ id: `fake_evt_${randomUUID()}`, type: "checkout.expired", sessionId });
  return { body, signature: signFakeEvent(body) };
}

/** 退款在 fake 里立即成功；回调事件由调用方投递 */
export const fakeRefundEvents: { body: string; signature: string }[] = [];

export function createFakeProvider(): PaymentProvider {
  if (env().NODE_ENV === "production") throw new Error("fake payment provider is not allowed in production");
  return {
    name: "fake",

    async createCheckout(input): Promise<CheckoutSession> {
      const existing = idempotency.get(input.idempotencyKey);
      if (existing && sessions.has(existing)) {
        const s = sessions.get(existing)!;
        return { sessionId: s.sessionId, url: `${env().APP_URL}/dev/checkout/${s.sessionId}`, expiresAt: s.expiresAt };
      }
      const sessionId = `fake_cs_${randomUUID()}`;
      const expiresAt = new Date(Date.now() + 30 * 60_000);
      sessions.set(sessionId, {
        sessionId,
        orderId: input.orderId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        status: "open",
        paymentId: null,
        expiresAt,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
      });
      idempotency.set(input.idempotencyKey, sessionId);
      return { sessionId, url: `${env().APP_URL}/dev/checkout/${sessionId}`, expiresAt };
    },

    async retrieveCheckout(sessionId): Promise<CheckoutState> {
      const s = sessions.get(sessionId);
      if (!s) {
        return { sessionId, status: "expired", paid: false, amountMinor: null, currency: null, paymentId: null, orderId: null };
      }
      return {
        sessionId,
        status: s.status,
        paid: s.status === "complete",
        amountMinor: s.amountMinor,
        currency: s.currency,
        paymentId: s.paymentId,
        orderId: s.orderId,
      };
    },

    async refund({ paymentId }) {
      const s = [...sessions.values()].find((x) => x.paymentId === paymentId);
      const body = JSON.stringify({
        id: `fake_evt_${randomUUID()}`,
        type: "refund.succeeded",
        paymentId,
        amountRefundedMinor: s?.amountMinor ?? 0,
        currency: s?.currency ?? "usd",
      });
      fakeRefundEvents.push({ body, signature: signFakeEvent(body) });
      return { status: "pending" as const };
    },

    parseWebhook(rawBody, headers): PaymentEvent {
      const sig = headers.get("x-fake-signature");
      if (!sig || sig !== signFakeEvent(rawBody)) throw new WebhookSignatureError("bad fake signature");
      return JSON.parse(rawBody) as PaymentEvent;
    },
  };
}
