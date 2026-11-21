import { createHash, createHmac, randomUUID } from "node:crypto";
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

/**
 * 本地替身：结账页是 /dev/checkout/[sessionId]，点"模拟支付成功"后生成一个
 * 带签名的回调事件，交给与 Stripe 相同的处理流程。只在非生产环境可用。
 *
 * 按 Stripe 的契约模拟（附录 F.1）：
 * - 幂等键第一次被执行后保存结果；同一键 + 同样参数重放返回同一个会话（即使它已过期），
 *   同一键 + 不同参数被拒绝（idempotency_error）；
 * - 参数校验失败（有效期不足 30 分钟）不保存结果、不创建会话；
 * - 会话到达有效期后不可支付。
 * 测试可注入故障：请求没送达、会话已创建但响应丢失、支付方 5xx 且该结果被保存。
 * 退款行为可切换：同步成功、异步成功、异步失败、一直处理中；可模拟在支付方后台手动退款。
 */

interface FakeSession {
  sessionId: string;
  orderId: string;
  attemptId: string | null;
  amountMinor: number;
  currency: string;
  status: "open" | "complete" | "expired";
  paymentId: string | null;
  expiresAt: Date;
  successUrl: string;
  cancelUrl: string;
  createdAt: Date;
}

interface FakeRefund extends ProviderRefund {
  paymentId: string;
}

type Saved = { hash: string; session?: CheckoutSession; error?: CheckoutCreateError };

export type FakeRefundBehavior = "succeed_sync" | "succeed_async" | "fail_async" | "pending";
/** fail_before：请求没送达；lose_response：会话已创建、响应丢失；server_error_saved：5xx 且被保存在幂等键下 */
export type FakeCheckoutFault = "fail_before" | "lose_response" | "server_error_saved";
export type FakeRefundFault = "fail_before" | "lose_response";

const g = globalThis as unknown as {
  __fakeCheckouts?: Map<string, FakeSession>;
  __fakeIdem?: Map<string, Saved>;
  __fakeRefunds?: Map<string, FakeRefund>;
  __fakeRefundIdem?: Map<string, { hash: string; refundId: string }>;
  __fakeRefundBehavior?: FakeRefundBehavior;
  __fakeCreateCalls?: number;
  __fakeCreateRequests?: number;
  __fakeRefundRequests?: number;
  __fakeCheckoutFaults?: FakeCheckoutFault[];
  __fakeRefundFaults?: FakeRefundFault[];
};
const sessions = (g.__fakeCheckouts ??= new Map());
const idempotency = (g.__fakeIdem ??= new Map());
const refunds = (g.__fakeRefunds ??= new Map());
const refundIdem = (g.__fakeRefundIdem ??= new Map());
const checkoutFaults = (g.__fakeCheckoutFaults ??= []);
const refundFaults = (g.__fakeRefundFaults ??= []);

const SECRET = "fake-webhook-secret";
/** Stripe：expires_at 至少在请求时刻之后 30 分钟 */
const MIN_TTL_MS = 30 * 60_000;

export function signFakeEvent(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

export function getFakeSession(sessionId: string): FakeSession | undefined {
  const s = sessions.get(sessionId);
  if (s) lazyExpire(s);
  return s;
}

/** 测试用：切换退款结果 */
export function __setFakeRefundBehavior(b: FakeRefundBehavior): void {
  g.__fakeRefundBehavior = b;
}

/** 测试用：Checkout 实际被创建的次数（验证幂等复用） */
export function __fakeCheckoutCreates(): number {
  return g.__fakeCreateCalls ?? 0;
}

/** 测试用：支付方收到的 Checkout 创建请求次数（含重放） */
export function __fakeCheckoutRequests(): number {
  return g.__fakeCreateRequests ?? 0;
}

/** 测试用：支付方收到的退款请求次数（含重放） */
export function __fakeRefundRequests(): number {
  return g.__fakeRefundRequests ?? 0;
}

/** 测试用：下一次 Checkout 创建请求注入故障（按顺序消费） */
export function __queueFakeCheckoutFault(...f: FakeCheckoutFault[]): void {
  checkoutFaults.push(...f);
}

export function __queueFakeRefundFault(...f: FakeRefundFault[]): void {
  refundFaults.push(...f);
}

function lazyExpire(s: FakeSession): void {
  if (s.status === "open" && s.expiresAt.getTime() <= Date.now()) s.status = "expired";
}

/** 模拟用户在结账页付款成功，返回对应的回调请求体 */
export function completeFakeCheckout(sessionId: string): { body: string; signature: string } {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("unknown fake session");
  lazyExpire(s);
  if (s.status === "expired") throw new Error("fake session expired; it can no longer be paid");
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

function publicRefund(r: FakeRefund): ProviderRefund {
  return { refundId: r.refundId, paymentId: r.paymentId, attemptId: r.attemptId, status: r.status, amountMinor: r.amountMinor, currency: r.currency, failureReason: r.failureReason };
}

function refundEvent(r: FakeRefund): Record<string, unknown> {
  return { type: "refund.updated", ...publicRefund(r) };
}

/** 测试用：把一笔处理中的退款结算为成功或失败，并排队对应回调 */
export function __settleFakeRefund(refundId: string, status: ProviderRefundStatus): void {
  const r = refunds.get(refundId);
  if (!r) throw new Error("unknown fake refund");
  r.status = status;
  r.failureReason = status === "failed" ? "expired_or_canceled_card" : null;
  queueEvent(refundEvent(r));
  if (status === "succeeded") {
    queueEvent({ type: "refund.succeeded", paymentId: r.paymentId, amountRefundedMinor: cumulativeRefunded(r.paymentId), currency: r.currency });
  }
}

/** 测试用：在"支付方后台"手动退款（不带本系统的元数据），排队对应回调 */
export function __fakeExternalRefund(paymentId: string, amountMinor: number, currency = "usd"): string {
  const r: FakeRefund = { refundId: `fake_re_ext_${randomUUID()}`, paymentId, attemptId: null, status: "succeeded", amountMinor, currency, failureReason: null };
  refunds.set(r.refundId, r);
  queueEvent(refundEvent(r));
  queueEvent({ type: "refund.succeeded", paymentId, amountRefundedMinor: cumulativeRefunded(paymentId), currency });
  return r.refundId;
}

function toState(s: FakeSession): CheckoutState {
  lazyExpire(s);
  return {
    sessionId: s.sessionId,
    status: s.status,
    paid: s.status === "complete",
    amountMinor: s.amountMinor,
    currency: s.currency,
    paymentId: s.paymentId,
    orderId: s.orderId,
    attemptId: s.attemptId,
    expiresAt: s.expiresAt,
    url: `${env().APP_URL}/dev/checkout/${s.sessionId}`,
  };
}

function paramsHash(input: CreateCheckoutInput): string {
  const { idempotencyKey: _k, ...params } = input;
  return createHash("sha256").update(JSON.stringify({ ...params, expiresAt: Math.floor(params.expiresAt.getTime() / 1000) })).digest("hex");
}

export function createFakeProvider(): PaymentProvider {
  if (env().NODE_ENV === "production") throw new Error("fake payment provider is not allowed in production");
  return {
    name: "fake",

    async createCheckout(input): Promise<CheckoutSession> {
      g.__fakeCreateRequests = (g.__fakeCreateRequests ?? 0) + 1;
      const fault = checkoutFaults.shift();
      if (fault === "fail_before") throw new CheckoutCreateError("unknown", "fake: connection reset before the request reached the provider");
      const hash = paramsHash(input);
      const saved = idempotency.get(input.idempotencyKey);
      if (saved) {
        if (saved.hash !== hash) {
          throw new CheckoutCreateError("param_mismatch", "fake: Keys for idempotent requests can only be used with the same parameters they were first used with");
        }
        if (saved.error) throw saved.error;
        return { ...saved.session! };
      }
      if (fault === "server_error_saved") {
        const error = new CheckoutCreateError("unknown", "fake: provider returned 500 (saved under this idempotency key)");
        idempotency.set(input.idempotencyKey, { hash, error });
        throw error;
      }
      if (input.expiresAt.getTime() < Date.now() + MIN_TTL_MS) {
        // 校验失败：不保存结果，没有创建会话
        throw new CheckoutCreateError("not_created", "fake: expires_at must be at least 30 minutes in the future");
      }
      g.__fakeCreateCalls = (g.__fakeCreateCalls ?? 0) + 1;
      const sessionId = `fake_cs_${randomUUID()}`;
      sessions.set(sessionId, {
        sessionId,
        orderId: input.orderId,
        attemptId: input.attemptId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        status: "open",
        paymentId: null,
        expiresAt: new Date(Math.floor(input.expiresAt.getTime() / 1000) * 1000),
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
        createdAt: new Date(),
      });
      const session = { sessionId, url: `${env().APP_URL}/dev/checkout/${sessionId}`, expiresAt: sessions.get(sessionId)!.expiresAt };
      idempotency.set(input.idempotencyKey, { hash, session });
      if (fault === "lose_response") throw new CheckoutCreateError("unknown", "fake: socket hang up after the session was created");
      return { ...session };
    },

    async retrieveCheckout(sessionId): Promise<CheckoutState> {
      const s = sessions.get(sessionId);
      if (!s) {
        return { sessionId, status: "expired", paid: false, amountMinor: null, currency: null, paymentId: null, orderId: null, attemptId: null, expiresAt: null, url: null };
      }
      return toState(s);
    },

    async findCheckout({ attemptId, orderId, createdAfter }) {
      for (const s of sessions.values()) {
        if (s.createdAt.getTime() < createdAfter.getTime()) continue;
        if (attemptId ? s.attemptId === attemptId : s.orderId === orderId && !s.attemptId) return toState(s);
      }
      return null;
    },

    async expireCheckout(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return "already_expired";
      lazyExpire(s);
      if (s.status === "expired") return "already_expired";
      if (s.status === "complete") return "already_complete";
      s.status = "expired";
      return "expired";
    },

    async refund({ paymentId, idempotencyKey, attemptId, orderId }): Promise<ProviderRefund> {
      g.__fakeRefundRequests = (g.__fakeRefundRequests ?? 0) + 1;
      const fault = refundFaults.shift();
      if (fault === "fail_before") throw new Error("fake: connection reset before the refund request reached the provider");
      const hash = JSON.stringify({ paymentId, attemptId, orderId });
      const known = refundIdem.get(idempotencyKey);
      if (known) {
        if (known.hash !== hash) throw new Error("fake: idempotency_error (refund parameters differ)");
        return publicRefund(refunds.get(known.refundId)!);
      }
      const session = [...sessions.values()].find((x) => x.paymentId === paymentId);
      const amount = (session?.amountMinor ?? 0) - cumulativeRefunded(paymentId);
      if (amount <= 0) throw new RefundRejectedError("charge_already_refunded", "fake: charge has already been refunded");
      const behavior = g.__fakeRefundBehavior ?? "succeed_async";
      const r: FakeRefund = {
        refundId: `fake_re_${randomUUID()}`,
        paymentId,
        attemptId,
        status: behavior === "succeed_sync" ? "succeeded" : "pending",
        amountMinor: amount,
        currency: session?.currency ?? "usd",
        failureReason: null,
      };
      refunds.set(r.refundId, r);
      refundIdem.set(idempotencyKey, { hash, refundId: r.refundId });
      let returned: ProviderRefund = publicRefund(r);
      if (behavior === "succeed_sync") {
        queueEvent(refundEvent(r));
        queueEvent({ type: "refund.succeeded", paymentId, amountRefundedMinor: cumulativeRefunded(paymentId), currency: r.currency });
      } else if (behavior === "succeed_async") {
        // 调用方看到的是处理中；成功通过回调到达
        __settleFakeRefund(r.refundId, "succeeded");
        returned = { ...publicRefund(r), status: "pending" };
      } else if (behavior === "fail_async") {
        __settleFakeRefund(r.refundId, "failed");
        returned = { ...publicRefund(r), status: "pending", failureReason: null };
      }
      if (fault === "lose_response") throw new Error("fake: socket hang up after the refund was created");
      return returned;
    },

    async retrieveRefund(refundId) {
      const r = refunds.get(refundId);
      if (!r) throw new Error("unknown fake refund");
      return publicRefund(r);
    },

    async listRefunds(paymentId) {
      return [...refunds.values()].filter((r) => r.paymentId === paymentId).map(publicRefund);
    },

    parseWebhook(rawBody, headers): PaymentEvent {
      const sig = headers.get("x-fake-signature");
      if (!sig || sig !== signFakeEvent(rawBody)) throw new WebhookSignatureError("bad fake signature");
      return JSON.parse(rawBody) as PaymentEvent;
    },
  };
}
