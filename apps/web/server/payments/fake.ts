import { createHmac, randomUUID } from "node:crypto";
import { env } from "../env";
import {
  WebhookSignatureError,
  type CheckoutSession,
  type CheckoutState,
  type PaymentEvent,
  type PaymentProvider,
  type ProviderRefund,
  type ProviderRefundStatus,
} from "./types";

/**
 * 本地替身：结账页是 /dev/checkout/[sessionId]，点"模拟支付成功"后生成一个
 * 带签名的回调事件，交给与 Stripe 相同的处理流程。只在非生产环境可用。
 * 退款行为可在测试里切换：同步成功、异步成功、异步失败、一直处理中。
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

interface FakeRefund extends ProviderRefund {
  paymentId: string;
}

export type FakeRefundBehavior = "succeed_sync" | "succeed_async" | "fail_async" | "pending";

const g = globalThis as unknown as {
  __fakeCheckouts?: Map<string, FakeSession>;
  __fakeIdem?: Map<string, string>;
  __fakeRefunds?: Map<string, FakeRefund>;
  __fakeRefundIdem?: Map<string, string>;
  __fakeRefundBehavior?: FakeRefundBehavior;
  __fakeCreateCalls?: number;
};
const sessions = (g.__fakeCheckouts ??= new Map());
const idempotency = (g.__fakeIdem ??= new Map());
const refunds = (g.__fakeRefunds ??= new Map());
const refundIdem = (g.__fakeRefundIdem ??= new Map());

const SECRET = "fake-webhook-secret";

export function signFakeEvent(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

export function getFakeSession(sessionId: string): FakeSession | undefined {
  return sessions.get(sessionId);
}

/** 测试用：切换退款结果 */
export function __setFakeRefundBehavior(b: FakeRefundBehavior): void {
  g.__fakeRefundBehavior = b;
}

/** 测试用：Checkout 实际被创建的次数（验证幂等复用） */
export function __fakeCheckoutCreates(): number {
  return g.__fakeCreateCalls ?? 0;
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

/** 退款相关的回调在 fake 里排队，由调用方投递（模拟 Stripe 的异步 webhook） */
export const fakeRefundEvents: { body: string; signature: string }[] = [];

function queueEvent(e: Record<string, unknown>): void {
  const body = JSON.stringify({ id: `fake_evt_${randomUUID()}`, ...e });
  fakeRefundEvents.push({ body, signature: signFakeEvent(body) });
}

function cumulativeRefunded(paymentId: string): number {
  return [...refunds.values()].filter((r) => r.paymentId === paymentId && r.status === "succeeded").reduce((s, r) => s + r.amountMinor, 0);
}

/** 测试用：把一笔处理中的退款结算为成功或失败，并排队对应回调 */
export function __settleFakeRefund(refundId: string, status: ProviderRefundStatus): void {
  const r = refunds.get(refundId);
  if (!r) throw new Error("unknown fake refund");
  r.status = status;
  r.failureReason = status === "failed" ? "expired_or_canceled_card" : null;
  queueEvent({ type: "refund.updated", refundId, paymentId: r.paymentId, status, amountMinor: r.amountMinor, currency: r.currency, failureReason: r.failureReason });
  if (status === "succeeded") {
    queueEvent({ type: "refund.succeeded", paymentId: r.paymentId, amountRefundedMinor: cumulativeRefunded(r.paymentId), currency: r.currency });
  }
}

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
      g.__fakeCreateCalls = (g.__fakeCreateCalls ?? 0) + 1;
      const sessionId = `fake_cs_${randomUUID()}`;
      const expiresAt = new Date(Date.now() + 31 * 60_000);
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

    async expireCheckout(sessionId) {
      const s = sessions.get(sessionId);
      if (!s || s.status === "expired") return "already_expired";
      if (s.status === "complete") return "already_complete";
      s.status = "expired";
      return "expired";
    },

    async refund({ paymentId, idempotencyKey }): Promise<ProviderRefund> {
      const known = refundIdem.get(idempotencyKey);
      if (known) return { ...refunds.get(known)! };
      const session = [...sessions.values()].find((x) => x.paymentId === paymentId);
      const amount = (session?.amountMinor ?? 0) - cumulativeRefunded(paymentId);
      const behavior = g.__fakeRefundBehavior ?? "succeed_async";
      const r: FakeRefund = {
        refundId: `fake_re_${randomUUID()}`,
        paymentId,
        status: behavior === "succeed_sync" ? "succeeded" : "pending",
        amountMinor: amount,
        currency: session?.currency ?? "usd",
        failureReason: null,
      };
      refunds.set(r.refundId, r);
      refundIdem.set(idempotencyKey, r.refundId);
      if (behavior === "succeed_sync") {
        queueEvent({ type: "refund.succeeded", paymentId, amountRefundedMinor: cumulativeRefunded(paymentId), currency: r.currency });
      } else if (behavior === "succeed_async") {
        __settleFakeRefund(r.refundId, "succeeded");
        r.status = "pending"; // 调用方看到的是处理中；成功通过回调到达
        refunds.get(r.refundId)!.status = "succeeded";
        return { ...r, status: "pending" };
      } else if (behavior === "fail_async") {
        __settleFakeRefund(r.refundId, "failed");
        return { ...r, status: "pending", failureReason: null };
      }
      return { ...r };
    },

    async retrieveRefund(refundId) {
      const r = refunds.get(refundId);
      if (!r) throw new Error("unknown fake refund");
      return { refundId: r.refundId, status: r.status, amountMinor: r.amountMinor, currency: r.currency, failureReason: r.failureReason };
    },

    parseWebhook(rawBody, headers): PaymentEvent {
      const sig = headers.get("x-fake-signature");
      if (!sig || sig !== signFakeEvent(rawBody)) throw new WebhookSignatureError("bad fake signature");
      return JSON.parse(rawBody) as PaymentEvent;
    },
  };
}
