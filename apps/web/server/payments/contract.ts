import { randomUUID } from "node:crypto";
import { CheckoutCreateError, RefundRejectedError, type CreateCheckoutInput, type PaymentProvider } from "./types";

/**
 * 支付适配器契约（附录 F.1）。同一组检查既在单元测试里对 fake 运行，
 * 也在真实联调时对 Stripe 测试模式运行（npm run acceptance -- --service=stripe），
 * 用来确认我们依赖的支付方行为确实成立：
 * - 同一幂等键 + 同样参数 → 同一个会话；同一键 + 不同参数 → 被拒绝（param_mismatch）；
 * - 参数校验失败（有效期不足 30 分钟）→ 没有创建，且不占用这个键；
 * - 响应丢失后能按付款尝试 ID 找回会话；关闭后的会话不可再支付；
 * - 退款：同一键返回同一笔退款，元数据带回尝试 ID，可按付款列出；已全额退款后再退被明确拒绝。
 */

export interface ContractCheck {
  name: string;
  ok: boolean;
  detail: string;
}

async function check(out: ContractCheck[], name: string, fn: () => Promise<string>): Promise<void> {
  try {
    out.push({ name, ok: true, detail: await fn() });
  } catch (err) {
    out.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function expectCreateError(p: Promise<unknown>, kind: CheckoutCreateError["kind"]): Promise<string> {
  try {
    await p;
  } catch (err) {
    assert(err instanceof CheckoutCreateError, `expected CheckoutCreateError(${kind}), got ${err instanceof Error ? err.name : String(err)}`);
    assert(err.kind === kind, `expected ${kind}, got ${err.kind}: ${err.message}`);
    return `${kind}: ${err.message.slice(0, 120)}`;
  }
  throw new Error(`expected ${kind}, but the request succeeded`);
}

export async function runCheckoutContract(
  provider: PaymentProvider,
  opts: { email: string; amountMinor: number; currency: string; appUrl: string },
): Promise<ContractCheck[]> {
  const out: ContractCheck[] = [];
  const orderId = randomUUID();
  const attemptId = randomUUID();
  const base: CreateCheckoutInput = {
    orderId,
    attemptId,
    amountMinor: opts.amountMinor,
    currency: opts.currency,
    email: opts.email,
    description: "问山联调（契约测试，不会被支付）",
    successUrl: `${opts.appUrl}/orders/${orderId}?from=checkout`,
    cancelUrl: `${opts.appUrl}/`,
    expiresAt: new Date(Math.floor((Date.now() + 40 * 60_000) / 1000) * 1000),
    idempotencyKey: `contract:${attemptId}`,
  };
  let sessionId = "";

  await check(out, "create returns the requested expiry", async () => {
    const s = await provider.createCheckout(base);
    sessionId = s.sessionId;
    assert(Math.abs(s.expiresAt.getTime() - base.expiresAt.getTime()) < 1000, `expiresAt ${s.expiresAt.toISOString()} != requested ${base.expiresAt.toISOString()}`);
    return s.sessionId;
  });
  await check(out, "same key + same params replays the same session", async () => {
    const s = await provider.createCheckout(base);
    assert(s.sessionId === sessionId, `replay returned ${s.sessionId}, first was ${sessionId}`);
    return s.sessionId;
  });
  await check(out, "same key + different expiry is rejected", () =>
    expectCreateError(provider.createCheckout({ ...base, expiresAt: new Date(base.expiresAt.getTime() + 60_000) }), "param_mismatch"),
  );
  const shortKey = `contract:${randomUUID()}`;
  const shortAttempt = randomUUID();
  await check(out, "an expiry under 30 minutes is not created", () =>
    expectCreateError(provider.createCheckout({ ...base, attemptId: shortAttempt, idempotencyKey: shortKey, expiresAt: new Date(Date.now() + 10 * 60_000) }), "not_created"),
  );
  await check(out, "a rejected (unsaved) key can then be used with valid params", async () => {
    const s = await provider.createCheckout({ ...base, attemptId: shortAttempt, idempotencyKey: shortKey });
    assert(s.sessionId !== sessionId, "expected a different session");
    await provider.expireCheckout(s.sessionId);
    return s.sessionId;
  });
  await check(out, "find by attempt id (response-lost recovery)", async () => {
    const found = await provider.findCheckout({ attemptId, orderId, createdAfter: new Date(Date.now() - 10 * 60_000) });
    assert(found?.sessionId === sessionId, `found ${found?.sessionId ?? "nothing"}`);
    assert(found.attemptId === attemptId && found.orderId === orderId, "metadata does not carry attempt/order id");
    return found.sessionId;
  });
  await check(out, "an expired session cannot be paid", async () => {
    const r = await provider.expireCheckout(sessionId);
    assert(r === "expired", `expireCheckout returned ${r}`);
    const s = await provider.retrieveCheckout(sessionId);
    assert(s.status === "expired" && !s.paid, `status ${s.status}, paid ${s.paid}`);
    return "expired";
  });
  return out;
}

export async function runRefundContract(provider: PaymentProvider, paymentId: string): Promise<ContractCheck[]> {
  const out: ContractCheck[] = [];
  const orderId = randomUUID();
  const attemptId = randomUUID();
  const key = `contract-refund:${attemptId}`;
  let refundId = "";
  await check(out, "refund carries the attempt id", async () => {
    const r = await provider.refund({ paymentId, idempotencyKey: key, attemptId, orderId });
    refundId = r.refundId;
    assert(r.attemptId === attemptId, `attemptId ${r.attemptId}`);
    assert(r.paymentId === paymentId, `paymentId ${r.paymentId}`);
    return `${r.refundId} ${r.status} ${r.amountMinor} ${r.currency}`;
  });
  await check(out, "same key replays the same refund", async () => {
    const r = await provider.refund({ paymentId, idempotencyKey: key, attemptId, orderId });
    assert(r.refundId === refundId, `replay returned ${r.refundId}`);
    return r.refundId;
  });
  await check(out, "retrieve and list return the same refund", async () => {
    const r = await provider.retrieveRefund(refundId);
    const list = await provider.listRefunds(paymentId);
    assert(r.refundId === refundId, "retrieve mismatch");
    assert(list.some((x) => x.refundId === refundId && x.attemptId === attemptId), "list does not include the refund with its attempt id");
    return `${list.length} refund(s) on the payment`;
  });
  await check(out, "refunding a fully refunded payment is rejected", async () => {
    try {
      await provider.refund({ paymentId, idempotencyKey: `contract-refund:${randomUUID()}`, attemptId: randomUUID(), orderId });
    } catch (err) {
      assert(err instanceof RefundRejectedError, `expected RefundRejectedError, got ${err instanceof Error ? err.name : String(err)}`);
      return err.code;
    }
    throw new Error("second full refund was accepted");
  });
  return out;
}
