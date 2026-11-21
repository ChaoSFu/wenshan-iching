/**
 * 第三轮验收（技术方案附录 F）：
 * P0 Checkout 在真实支付方契约下可重试；P0 按实际资金流水结算退款与交付；
 * P1 通知的认领与"已被接受"分开；P1 删除后迟到的写回不能恢复已清除的内容。
 * 断言以数据库终态、用户可见结果和支付方调用次数为主。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { __setEnvForTests, type Env } from "@/server/env";
import type { DB } from "@/server/db/client";
import { checkoutAttempts, jobs, opsActions, orders, refunds, reports, supportTickets, triageResults } from "@/server/db/schema";
import { drainJobs, runMaintenance } from "@/server/jobs/runner";
import { __setLlmForTests, getLlm, type LlmProvider, type StructuredRequest } from "@/server/llm";
import { __setMailerForTests, type Mailer, type MailMessage } from "@/server/mail";
import { listOrderExceptions } from "@/server/ops";
import { createOrderForReading, getOrderView, refundOverdueOrders, requestRefundByOps } from "@/server/orders";
import { __setPaymentProviderForTests, getPaymentProvider, type PaymentProvider } from "@/server/payments";
import { runCheckoutContract, runRefundContract } from "@/server/payments/contract";
import {
  __fakeCheckoutCreates,
  __fakeCheckoutRequests,
  __fakeExternalRefund,
  __fakeRefundRequests,
  __queueFakeCheckoutFault,
  __queueFakeRefundFault,
  __setFakeRefundBehavior,
  __settleFakeRefund,
  completeFakeCheckout,
  fakeRefundEvents,
  getFakeSession,
} from "@/server/payments/fake";
import { uploadReading } from "@/server/readings";
import { deliverFakeEvents, retryRefundByOps } from "@/server/refunds";
import { generateReport } from "@/server/report/generate";
import { deleteReport, getReportView, sendReportReadyEmail } from "@/server/report/service";
import { notifySupportTicket, submitTicket } from "@/server/support";
import { runTriage } from "@/server/triage";
import { confirmation, login as loginAt, sentMail, setupTestServer, tossesFor } from "./helpers";

/** 每个测试用户换一个来源 IP，避免验证码的按 IP 限流 */
let ipSeq = 0;
const login = (email: string) => loginAt(email, `10.3.${Math.floor(++ipSeq / 200)}.${ipSeq % 200}`);

const BASE: Partial<Env> = {
  PGLITE_DIR: "memory",
  APP_URL: "http://localhost:3000",
  SALES_ENABLED: true,
  ALLOW_UNREVIEWED_CONTENT: true,
  SUPPORT_NOTIFY_EMAIL: "ops-inbox@example.com",
};
const setEnv = (o: Partial<Env> = {}) => __setEnvForTests({ ...BASE, ...o });
const defaultMailer: Mailer = { send: async (m) => void sentMail.push(m) };

let db: DB;
beforeAll(async () => {
  db = await setupTestServer(BASE);
});

let n = 0;
async function triaged(user: { id: string }, question = "要不要接下这个外包项目？") {
  const clientReadingId = `round3-${++n}-xxxxxxxx`;
  const r = await uploadReading(user.id, {
    clientReadingId,
    question,
    topicId: "career",
    topicOriginal: "career",
    context: {},
    tosses: tossesFor([9, 7, 7, 7, 7, 7]),
    consent: true,
  });
  await runTriage(user.id, r.readingId);
  return { ...r, clientReadingId };
}

async function attempts(orderId: string) {
  return (await db.select().from(checkoutAttempts).where(eq(checkoutAttempts.orderId, orderId))).sort((a, b) => a.attemptNo - b.attemptNo);
}

async function orderRow(orderId: string) {
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  return o!;
}

async function payOrder(orderId: string) {
  const o = await orderRow(orderId);
  const { body, signature } = completeFakeCheckout(o.providerSessionId!);
  const { handlePaymentEvent } = await import("@/server/orders");
  return handlePaymentEvent(getPaymentProvider().parseWebhook(body, new Headers({ "x-fake-signature": signature })));
}

async function delivered(email: string) {
  const user = await login(email);
  const r = await triaged(user);
  const { orderId } = await createOrderForReading(user, await confirmation(r.readingId));
  await payOrder(orderId);
  await drainJobs();
  const view = await getOrderView(user.id, orderId);
  expect(view.status).toBe("delivered");
  return { user, ...r, orderId, reportId: view.reportId! };
}

/** 失败后排队重试的任务立即到期 */
async function makeJobsDue() {
  await db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.status, "queued"));
}

function withProvider(patch: Partial<PaymentProvider>) {
  const real = getPaymentProvider();
  __setPaymentProviderForTests({ ...real, ...patch } as PaymentProvider);
  return () => __setPaymentProviderForTests(null);
}

// ---------------------------------------------------------------- P0 · Checkout

describe("P0 · Checkout stays retryable under the payment provider's idempotency contract", () => {
  it("the fake adapter passes the same contract checks that run against Stripe test mode", async () => {
    const provider = getPaymentProvider();
    const checks = await runCheckoutContract(provider, { email: "contract@example.com", amountMinor: 990, currency: "usd", appUrl: "http://localhost:3000" });
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.map((c) => c.name)).toContain("same key + different expiry is rejected");

    const s = await provider.createCheckout({
      orderId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      amountMinor: 990,
      currency: "usd",
      email: "contract@example.com",
      description: "contract",
      successUrl: "http://localhost:3000/ok",
      cancelUrl: "http://localhost:3000/",
      expiresAt: new Date(Date.now() + 40 * 60_000),
      idempotencyKey: `contract:${crypto.randomUUID()}`,
    });
    completeFakeCheckout(s.sessionId);
    const paid = await provider.retrieveCheckout(s.sessionId);
    __setFakeRefundBehavior("succeed_sync");
    const refundChecks = await runRefundContract(provider, paid.paymentId!);
    __setFakeRefundBehavior("succeed_async");
    fakeRefundEvents.splice(0);
    expect(refundChecks.filter((c) => !c.ok)).toEqual([]);
  });

  it("persists the attempt and its stable parameters before the first request; a retry replays them exactly", async () => {
    const user = await login("r3-persist@example.com");
    const r = await triaged(user);
    const input = await confirmation(r.readingId);
    const creates = __fakeCheckoutCreates();
    const requests = __fakeCheckoutRequests();
    __queueFakeCheckoutFault("fail_before");
    await expect(createOrderForReading(user, input)).rejects.toMatchObject({ status: 503, code: "payment_unavailable" });

    const [o] = await db.select().from(orders).where(eq(orders.readingId, r.readingId));
    const [a1] = await attempts(o!.id);
    expect(a1).toMatchObject({ attemptNo: 1, status: "unknown", tries: 1, amountMinor: 990, currency: "usd", providerSessionId: null });
    expect(a1!.idempotencyKey).toBe(`checkout:${o!.id}:${a1!.id}`);
    expect(a1!.successUrl).toBe(`http://localhost:3000/orders/${o!.id}?from=checkout`);

    const retry = await createOrderForReading(user, input);
    expect(retry.orderId).toBe(o!.id);
    const after = await attempts(o!.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: a1!.id, status: "open", tries: 2 });
    // 支付方看到的有效期就是第一次持久化的那个（没有重算）
    const session = getFakeSession(after[0]!.providerSessionId!)!;
    expect(Math.floor(session.expiresAt.getTime() / 1000)).toBe(Math.floor(a1!.requestedExpiresAt.getTime() / 1000));
    expect(session.attemptId).toBe(a1!.id);
    expect(__fakeCheckoutCreates() - creates).toBe(1);
    expect(__fakeCheckoutRequests() - requests).toBe(2);
    expect(after[0]!.providerExpiresAt?.getTime()).toBe(session.expiresAt.getTime());
  });

  it("finds the same session when the provider created it but the first response was lost", async () => {
    const user = await login("r3-lost@example.com");
    const r = await triaged(user);
    const input = await confirmation(r.readingId);
    const creates = __fakeCheckoutCreates();
    const requests = __fakeCheckoutRequests();

    // 对账接口也暂时不可用：第一次只能返回 503
    const restore = withProvider({
      findCheckout: async () => {
        throw new Error("list unavailable");
      },
    });
    __queueFakeCheckoutFault("lose_response");
    await expect(createOrderForReading(user, input)).rejects.toMatchObject({ status: 503 });
    restore();
    // 重试用同一幂等键、同样参数重放：支付方返回第一次已创建的会话
    const retry = await createOrderForReading(user, input);
    const [a] = await attempts(retry.orderId);
    expect(retry.checkoutUrl).toBe(`http://localhost:3000/dev/checkout/${a!.providerSessionId}`);
    expect(__fakeCheckoutCreates() - creates).toBe(1);
    expect(__fakeCheckoutRequests() - requests).toBe(2);
    expect((await createOrderForReading(user, input)).checkoutUrl).toBe(retry.checkoutUrl);

    await payOrder(retry.orderId);
    const paid = await orderRow(retry.orderId);
    expect(paid).toMatchObject({ status: "paid", paidAmountMinor: 990, paidCurrency: "usd" });
    expect((await attempts(retry.orderId))[0]).toMatchObject({ status: "complete", providerPaymentId: paid.providerPaymentId });
    await drainJobs();

    // 对账可用时，第一次请求就能按尝试 ID 找回会话
    const other = await triaged(user, "要不要接下第二个外包项目？");
    const c2 = __fakeCheckoutCreates();
    __queueFakeCheckoutFault("lose_response");
    const first = await createOrderForReading(user, await confirmation(other.readingId));
    expect(first.checkoutUrl).toBeTruthy();
    expect(__fakeCheckoutCreates() - c2).toBe(1);
  });

  it("opens a new attempt only after confirming the old one never created a session", async () => {
    const user = await login("r3-unknown@example.com");
    const r = await triaged(user);
    const input = await confirmation(r.readingId);
    const creates = __fakeCheckoutCreates();
    // 支付方 5xx，且这个结果被保存在幂等键下：重放只会得到同样的错误
    __queueFakeCheckoutFault("server_error_saved");
    await expect(createOrderForReading(user, input)).rejects.toMatchObject({ status: 503 });
    await expect(createOrderForReading(user, input)).rejects.toMatchObject({ status: 503 });
    const [o] = await db.select().from(orders).where(eq(orders.readingId, r.readingId));
    expect((await attempts(o!.id)).map((a) => a.status)).toEqual(["unknown"]);
    // 两分钟后仍查无此会话：确认没有创建，作废后开新尝试
    await db.update(checkoutAttempts).set({ createdAt: new Date(Date.now() - 3 * 60_000) }).where(eq(checkoutAttempts.orderId, o!.id));
    const ok = await createOrderForReading(user, input);
    expect(ok.checkoutUrl).toBeTruthy();
    const list = await attempts(o!.id);
    expect(list.map((a) => [a.attemptNo, a.status])).toEqual([
      [1, "failed"],
      [2, "open"],
    ]);
    expect(list[0]!.lastError).toBe("not_found_at_provider");
    expect(__fakeCheckoutCreates() - creates).toBe(1);

    // 创建前失败、之后重放被参数校验拒绝（有效期已不足 30 分钟）：支付方明确没有创建，换新尝试
    const r2 = await triaged(user, "要不要接下第三个外包项目？");
    const input2 = await confirmation(r2.readingId);
    __queueFakeCheckoutFault("fail_before");
    await expect(createOrderForReading(user, input2)).rejects.toMatchObject({ status: 503 });
    const [o2] = await db.select().from(orders).where(eq(orders.readingId, r2.readingId));
    await db.update(checkoutAttempts).set({ requestedExpiresAt: new Date(Date.now() + 20 * 60_000) }).where(eq(checkoutAttempts.orderId, o2!.id));
    expect((await createOrderForReading(user, input2)).checkoutUrl).toBeTruthy();
    expect((await attempts(o2!.id)).map((a) => a.status)).toEqual(["failed", "open"]);
  });

  it("confirms an expired or expiring session cannot be paid before replacing it, and adopts a payment that landed first", async () => {
    const user = await login("r3-expiry@example.com");
    const r = await triaged(user);
    const input = await confirmation(r.readingId);
    const first = await createOrderForReading(user, input);
    const [a1] = await attempts(first.orderId);

    // 1. 会话已过期：作废后开新尝试；旧会话不能再付
    getFakeSession(a1!.providerSessionId!)!.expiresAt = new Date(Date.now() - 1000);
    await db.update(checkoutAttempts).set({ providerExpiresAt: new Date(Date.now() - 1000) }).where(eq(checkoutAttempts.id, a1!.id));
    const second = await createOrderForReading(user, input);
    expect(second.orderId).toBe(first.orderId);
    expect(second.checkoutUrl).not.toBe(first.checkoutUrl);
    expect(() => completeFakeCheckout(a1!.providerSessionId!)).toThrow(/expired/);

    // 2. 会话还开着但快到期：先在支付方关闭，再开新尝试
    const [, a2] = await attempts(first.orderId);
    await db.update(checkoutAttempts).set({ providerExpiresAt: new Date(Date.now() + 60_000) }).where(eq(checkoutAttempts.id, a2!.id));
    const third = await createOrderForReading(user, input);
    expect(getFakeSession(a2!.providerSessionId!)!.status).toBe("expired");
    expect((await attempts(first.orderId)).map((a) => a.status)).toEqual(["expired", "expired", "open"]);

    // 3. 关闭前用户已经付了款（回调还没到）：按已付款处理，不再开新尝试
    const [, , a3] = await attempts(first.orderId);
    await db.update(checkoutAttempts).set({ providerExpiresAt: new Date(Date.now() + 60_000) }).where(eq(checkoutAttempts.id, a3!.id));
    completeFakeCheckout(a3!.providerSessionId!);
    const fourth = await createOrderForReading(user, input);
    expect(third.checkoutUrl).toBeTruthy();
    expect(fourth).toEqual({ orderId: first.orderId, checkoutUrl: null });
    expect((await orderRow(first.orderId)).status).toBe("paid");
    expect((await attempts(first.orderId)).map((a) => a.status)).toEqual(["expired", "expired", "complete"]);
    await drainJobs();
  });

  it("does not return a checkout link for an order that was deleted while the request was in flight", async () => {
    const user = await login("r3-closed@example.com");
    const r = await triaged(user);
    const input = await confirmation(r.readingId);
    let sessionId = "";
    const real = getPaymentProvider();
    const restore = withProvider({
      createCheckout: async (i) => {
        const s = await real.createCheckout(i);
        sessionId = s.sessionId;
        // 请求在途时，用户删除了这一卦（订单作废、内容清除）
        await db.update(orders).set({ status: "expired", contentPurgedAt: new Date() }).where(eq(orders.id, i.orderId));
        return s;
      },
    });
    await expect(createOrderForReading(user, input)).rejects.toMatchObject({ status: 409, code: "order_closed" });
    restore();
    const [o] = await db.select().from(orders).where(eq(orders.readingId, r.readingId));
    expect(o!.checkoutUrl).toBeNull();
    expect((await getOrderView(user.id, o!.id)).checkoutUrl).toBeNull();
    expect(await db.select().from(jobs).where(and(eq(jobs.kind, "expire_checkout"), eq(jobs.status, "queued")))).toHaveLength(1);
    await drainJobs();
    expect(getFakeSession(sessionId)!.status).toBe("expired");
    expect((await attempts(o!.id))[0]!.status).toBe("expired");
  });

  it("binds the quote id to the actual amount and currency, even when PRICE_VERSION is left unchanged", async () => {
    const user = await login("r3-quote@example.com");
    const r = await triaged(user);
    const seen = await confirmation(r.readingId);
    setEnv({ PRICE_AMOUNT_MINOR: 1290 }); // 改了价格，忘了改版本号
    await expect(createOrderForReading(user, seen)).rejects.toMatchObject({ status: 409, code: "price_changed" });
    const { orderId, checkoutUrl } = await createOrderForReading(user, await confirmation(r.readingId));
    setEnv();
    const o = await orderRow(orderId);
    expect(o).toMatchObject({ amountMinor: 1290, priceVersion: "price@2026-11:1290:usd" });
    expect(getFakeSession(checkoutUrl!.split("/").at(-1)!)!.amountMinor).toBe(1290);
  });
});

// ---------------------------------------------------------------- P0 · refunds and delivery

describe("P0 · refunds and delivery settle from the provider's actual money flows", () => {
  it("keeps quote, provider-confirmed payment and refunds apart; a full refund is measured against what was actually paid", async () => {
    const user = await login("r3-ledger@example.com");
    const r = await triaged(user);
    const { orderId } = await createOrderForReading(user, await confirmation(r.readingId));
    // 报价与实收不一致（例如结账页按旧金额收款）：进待核实，实收按支付方记
    await db.update(orders).set({ amountMinor: 1990 }).where(eq(orders.id, orderId));
    await payOrder(orderId);
    let v = await getOrderView(user.id, orderId);
    expect(v).toMatchObject({ status: "needs_review", amountMinor: 1990, paidAmountMinor: 990, paidCurrency: "usd", refundedAmountMinor: 0 });
    await requestRefundByOps(orderId, "amount mismatch verified", "ops@example.com");
    await drainJobs();
    v = await getOrderView(user.id, orderId);
    // 以实收 990 为基准判定整单退款（而不是报价 1990）
    expect(v).toMatchObject({ status: "refunded", refundedAmountMinor: 990, refundedCurrency: "usd", paidAmountMinor: 990 });
    const [rf] = await db.select().from(refunds).where(eq(refunds.orderId, orderId));
    expect(rf).toMatchObject({ status: "succeeded", amountMinor: 990, currency: "usd", source: "local", providerPaymentId: v.paidAmountMinor ? (await orderRow(orderId)).providerPaymentId : null });
  });

  it("a partial refund on a mismatched payment keeps it under review, and it can never be regenerated", async () => {
    const user = await login("r3-mismatch-partial@example.com");
    const r = await triaged(user);
    const { orderId } = await createOrderForReading(user, await confirmation(r.readingId));
    await db.update(orders).set({ amountMinor: 1990 }).where(eq(orders.id, orderId));
    await payOrder(orderId);
    __fakeExternalRefund((await orderRow(orderId)).providerPaymentId!, 100);
    await deliverFakeEvents();
    expect(await orderRow(orderId)).toMatchObject({ status: "needs_review", reviewReason: "amount_mismatch", refundedAmountMinor: 100 });
    const { requeueGenerationByOps } = await import("@/server/orders");
    await expect(requeueGenerationByOps(orderId, "ops@example.com", "try")).rejects.toMatchObject({ status: 409, code: "not_requeueable" });
    // 即使核实原因被改写，实收与报价不一致也不能重新生成
    await db.update(orders).set({ reviewReason: "partial_refund" }).where(eq(orders.id, orderId));
    await expect(requeueGenerationByOps(orderId, "ops@example.com", "try")).rejects.toMatchObject({ status: 409 });
  });

  it("routes an old order whose payment amount cannot be verified to the ops exception list", async () => {
    const { user, orderId } = await delivered("r3-legacy-paid@example.com");
    await db.update(orders).set({ paidAmountMinor: null, paidCurrency: null }).where(eq(orders.id, orderId)); // 迁移前的旧单
    __fakeExternalRefund((await orderRow(orderId)).providerPaymentId!, 990);
    await deliverFakeEvents();
    const v = await getOrderView(user.id, orderId);
    expect(v).toMatchObject({ status: "delivered", reviewReason: "payment_unverified", refundedAmountMinor: 990 });
    expect((await listOrderExceptions(orderId.slice(0, 8))).map((x) => x.id)).toContain(orderId);
  });

  describe("ops verification after a local failure", () => {
    async function locallyFailed(email: string) {
      const d = await delivered(email);
      __setFakeRefundBehavior("pending");
      await requestRefundByOps(d.orderId, "complaint", "ops@example.com");
      await drainJobs();
      const [att] = await db.select().from(refunds).where(eq(refunds.orderId, d.orderId));
      // 本地判定失败（例如误收了一条失败回调、或旧版本的误判）
      await db.update(refunds).set({ status: "failed", failureReason: "local_misjudgment" }).where(eq(refunds.id, att!.id));
      await db.update(orders).set({ status: "refund_failed", reviewReason: "refund_failed" }).where(eq(orders.id, d.orderId));
      __setFakeRefundBehavior("succeed_async");
      return { ...d, attempt: att! };
    }

    it("provider also says failed → a new attempt with its own key", async () => {
      const d = await locallyFailed("r3-verify-failed@example.com");
      __settleFakeRefund(d.attempt.providerRefundId!, "failed");
      fakeRefundEvents.splice(0);
      const msg = await retryRefundByOps(d.orderId, "ops@example.com", "provider confirmed failure");
      expect(msg).toContain("新的退款尝试");
      await drainJobs();
      const rows = await db.select().from(refunds).where(eq(refunds.orderId, d.orderId));
      expect(rows.map((x) => x.status).sort()).toEqual(["failed", "succeeded"]);
      expect((await getOrderView(d.user.id, d.orderId)).status).toBe("refunded");
      const acts = await db.select().from(opsActions).where(and(eq(opsActions.orderId, d.orderId), eq(opsActions.action, "retry_refund")));
      expect(acts.map((a) => a.result)).toEqual(["requested"]);
    });

    it("provider still processing → local record corrected, order back to refund_pending, no new attempt", async () => {
      const d = await locallyFailed("r3-verify-pending@example.com");
      const msg = await retryRefundByOps(d.orderId, "ops@example.com", "check");
      expect(msg).toContain("已同步状态");
      const rows = await db.select().from(refunds).where(eq(refunds.orderId, d.orderId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "pending", providerRefundId: d.attempt.providerRefundId });
      const v = await getOrderView(d.user.id, d.orderId);
      expect(v.status).toBe("refund_pending");
      expect("deleted" in (await getReportView(d.user.id, d.reportId))).toBe(true); // 退款中不可访问（订单不再是 delivered）
      const acts = await db.select().from(opsActions).where(and(eq(opsActions.orderId, d.orderId), eq(opsActions.action, "retry_refund")));
      expect(acts.map((a) => a.result)).toEqual(["synced:pending"]);
    });

    it("provider says succeeded → refunded, access revoked, logged as synced", async () => {
      const d = await locallyFailed("r3-verify-ok@example.com");
      __settleFakeRefund(d.attempt.providerRefundId!, "succeeded");
      fakeRefundEvents.splice(0); // 回调丢了，只能靠主动核实
      const msg = await retryRefundByOps(d.orderId, "ops@example.com", "check");
      expect(msg).toContain("succeeded");
      expect(await db.select().from(refunds).where(eq(refunds.orderId, d.orderId))).toHaveLength(1);
      const v = await getOrderView(d.user.id, d.orderId);
      expect(v).toMatchObject({ status: "refunded", refundedAmountMinor: 990, reportId: null });
      expect(await getReportView(d.user.id, d.reportId)).toMatchObject({ deleted: true });
      const [rep] = await db.select().from(reports).where(eq(reports.orderId, d.orderId));
      expect(rep!.contentCt).toBeNull();
      const acts = await db.select().from(opsActions).where(and(eq(opsActions.orderId, d.orderId), eq(opsActions.action, "retry_refund")));
      expect(acts.map((a) => a.result)).toEqual(["synced:succeeded"]);
    });

    it("records 'synced' only when the correction was actually written (same payment, same refund id)", async () => {
      const d = await locallyFailed("r3-verify-mismatch@example.com");
      const real = getPaymentProvider();
      const restore = withProvider({
        retrieveRefund: async (id) => ({ ...(await real.retrieveRefund(id)), paymentId: "pi_someone_else" }),
      });
      await expect(retryRefundByOps(d.orderId, "ops@example.com", "check")).rejects.toMatchObject({ status: 409, code: "refund_sync_rejected" });
      restore();
      const [row] = await db.select().from(refunds).where(eq(refunds.orderId, d.orderId));
      expect(row!.status).toBe("failed");
      expect((await orderRow(d.orderId)).status).toBe("refund_failed");
      const acts = await db.select().from(opsActions).where(and(eq(opsActions.orderId, d.orderId), eq(opsActions.action, "retry_refund")));
      expect(acts.map((a) => a.result)).toEqual(["sync_rejected:payment_id_mismatch"]);
    });
  });

  it("keeps webhook ordering protection apart from verified corrections (stale events, and a refund that fails after succeeding)", async () => {
    const d = await delivered("r3-order@example.com");
    await requestRefundByOps(d.orderId, "complaint", "ops@example.com");
    await drainJobs();
    expect((await getOrderView(d.user.id, d.orderId)).status).toBe("refunded");
    const [att] = await db.select().from(refunds).where(eq(refunds.orderId, d.orderId));
    const paymentId = (await orderRow(d.orderId)).providerPaymentId!;
    const { handlePaymentEvent } = await import("@/server/orders");
    const { signFakeEvent } = await import("@/server/payments/fake");
    const signed = (e: Record<string, unknown>) => {
      const body = JSON.stringify(e);
      return getPaymentProvider().parseWebhook(body, new Headers({ "x-fake-signature": signFakeEvent(body) }));
    };

    // 乱序到达的旧回调（pending）：不改终态，只触发一次主动核实；支付方仍是成功 → 不变
    await handlePaymentEvent(signed({ id: "evt_r3_stale", type: "refund.updated", refundId: att!.providerRefundId, paymentId, attemptId: att!.id, status: "pending", amountMinor: 990, currency: "usd", failureReason: null }));
    expect((await db.select().from(refunds).where(eq(refunds.id, att!.id)))[0]!.status).toBe("succeeded");
    expect(await db.select().from(jobs).where(and(eq(jobs.kind, "verify_refund"), eq(jobs.status, "queued")))).toHaveLength(1);
    await drainJobs();
    expect((await getOrderView(d.user.id, d.orderId)).status).toBe("refunded");

    // 支付方后来把这笔退款改为失败（Stripe 测试卡 4000 0000 0000 5126 的行为）：核实后更正，转运营
    __settleFakeRefund(att!.providerRefundId!, "failed");
    await deliverFakeEvents();
    await drainJobs();
    const v = await getOrderView(d.user.id, d.orderId);
    expect(v).toMatchObject({ status: "refund_failed", reviewReason: "refund_reversed", refundedAmountMinor: 0 });
    expect(await getReportView(d.user.id, d.reportId)).toMatchObject({ deleted: true }); // 已撤回的内容不恢复
  });

  it("books a dashboard refund on its own, binds our in-flight attempt only by its own refund id, and never double-counts", async () => {
    const d = await delivered("r3-identity@example.com");
    const paymentId = (await orderRow(d.orderId)).providerPaymentId!;
    const ext = __fakeExternalRefund(paymentId, 200); // 运营在支付方后台退了 200
    await deliverFakeEvents();
    let v = await getOrderView(d.user.id, d.orderId);
    expect(v).toMatchObject({ status: "delivered", refundedAmountMinor: 200, reviewReason: "partial_refund" });

    // 我们自己发起的剩余退款：支付方已受理，但响应丢了（本地还没有退款 ID）
    __setFakeRefundBehavior("pending");
    __queueFakeRefundFault("lose_response");
    const reqs = __fakeRefundRequests();
    await requestRefundByOps(d.orderId, "complaint", "ops@example.com");
    await drainJobs();
    const [ours] = await db.select().from(refunds).where(and(eq(refunds.orderId, d.orderId), eq(refunds.source, "local")));
    expect(ours!.providerRefundId).toBeNull();

    // 同一笔外部退款的回调又来一次：按退款 ID 找到外部记录，不会绑到我们这条在途尝试上
    const { handlePaymentEvent } = await import("@/server/orders");
    const { signFakeEvent } = await import("@/server/payments/fake");
    const body = JSON.stringify({ id: "evt_r3_ext_again", type: "refund.updated", refundId: ext, paymentId, status: "succeeded", amountMinor: 200, currency: "usd", failureReason: null });
    await handlePaymentEvent(getPaymentProvider().parseWebhook(body, new Headers({ "x-fake-signature": signFakeEvent(body) })));
    expect((await db.select().from(refunds).where(eq(refunds.id, ours!.id)))[0]!.providerRefundId).toBeNull();

    // 任务重试：同一幂等键重放，找回支付方那边的同一笔退款
    await makeJobsDue();
    await drainJobs();
    const [bound] = await db.select().from(refunds).where(eq(refunds.id, ours!.id));
    expect(bound!.providerRefundId).toMatch(/^fake_re_/);
    expect(__fakeRefundRequests() - reqs).toBe(2);
    expect((await getPaymentProvider().listRefunds(paymentId)).length).toBe(2);
    __settleFakeRefund(bound!.providerRefundId!, "succeeded");
    await deliverFakeEvents();
    __setFakeRefundBehavior("succeed_async");

    const rows = await db.select().from(refunds).where(eq(refunds.orderId, d.orderId));
    expect(rows.map((x) => [x.source, x.amountMinor, x.status]).sort()).toEqual([
      ["external", 200, "succeeded"],
      ["local", 790, "succeeded"],
    ]);
    v = await getOrderView(d.user.id, d.orderId);
    expect(v).toMatchObject({ status: "refunded", refundedAmountMinor: 990 });
  });

  it("escalates an attempt whose result stays unknown to manual verification, keeping the refunds already confirmed", async () => {
    const d = await delivered("r3-escalate@example.com");
    const paymentId = (await orderRow(d.orderId)).providerPaymentId!;
    __fakeExternalRefund(paymentId, 300); // 已有的成功退款证据
    await deliverFakeEvents();
    __queueFakeRefundFault("fail_before");
    await requestRefundByOps(d.orderId, "complaint", "ops@example.com");
    await drainJobs(); // 请求没送达，任务排队重试
    const [ours] = await db.select().from(refunds).where(and(eq(refunds.orderId, d.orderId), eq(refunds.source, "local")));
    // 达到重试上限、仍没有支付方退款 ID
    await db.update(refunds).set({ tries: 6, updatedAt: new Date(Date.now() - 20 * 60_000) }).where(eq(refunds.id, ours!.id));
    await runMaintenance();
    let v = await getOrderView(d.user.id, d.orderId);
    expect(v).toMatchObject({ status: "refund_failed", reviewReason: "refund_unconfirmed", refundedAmountMinor: 300 });
    expect((await db.select().from(refunds).where(eq(refunds.id, ours!.id)))[0]!.escalatedAt).not.toBeNull();
    expect((await listOrderExceptions(d.orderId.slice(0, 8)))[0]?.refunds.find((x) => x.source === "local")?.escalated).toBe(true);
    // 已转人工的尝试不再自动重试
    await makeJobsDue();
    await drainJobs();
    expect((await getPaymentProvider().listRefunds(paymentId)).length).toBe(1);

    // 运营核实：支付方查无此尝试 → 作废，开新尝试，退剩余金额
    expect(await retryRefundByOps(d.orderId, "ops@example.com", "not at provider")).toContain("新的退款尝试");
    await drainJobs();
    v = await getOrderView(d.user.id, d.orderId);
    expect(v).toMatchObject({ status: "refunded", refundedAmountMinor: 990 });
    const rows = await db.select().from(refunds).where(eq(refunds.orderId, d.orderId));
    expect(rows.map((x) => [x.source, x.status, x.amountMinor]).sort()).toEqual([
      ["external", "succeeded", 300],
      ["local", "failed", null],
      ["local", "succeeded", 690],
    ]);
  });

  describe("delivery vs. the overdue refund (one outcome, database time)", () => {
    async function paid(email: string) {
      const user = await login(email);
      const r = await triaged(user);
      const { orderId } = await createOrderForReading(user, await confirmation(r.readingId));
      await payOrder(orderId);
      return { user, orderId };
    }

    it("a report that finishes after the deadline is discarded and refunded exactly once", async () => {
      const { user, orderId } = await paid("r3-late@example.com");
      const base = getLlm();
      __setLlmForTests({
        ...base,
        name: "fake",
        generateStructured: async (req: StructuredRequest) => {
          if (req.route === "report") await db.update(orders).set({ refundDueAt: new Date(Date.now() - 1000) }).where(eq(orders.id, orderId));
          return base.generateStructured(req);
        },
      } as LlmProvider);
      expect(await generateReport(orderId)).toBe("discarded");
      __setLlmForTests(null);
      expect((await orderRow(orderId)).status).toBe("refund_pending");
      expect(await refundOverdueOrders()).toBe(0);
      expect(await db.select().from(refunds).where(eq(refunds.orderId, orderId))).toHaveLength(1);
      await drainJobs();
      expect(await getOrderView(user.id, orderId)).toMatchObject({ status: "refunded", reportId: null });
      expect(await db.select().from(reports).where(eq(reports.orderId, orderId))).toHaveLength(0);
    });

    it("a report delivered before the deadline is not refunded when the deadline later passes", async () => {
      const { user, orderId } = await paid("r3-ontime@example.com");
      await drainJobs();
      await db.update(orders).set({ refundDueAt: new Date(Date.now() - 1000) }).where(eq(orders.id, orderId));
      expect(await refundOverdueOrders()).toBe(0);
      const v = await getOrderView(user.id, orderId);
      expect(v.status).toBe("delivered");
      expect("deleted" in (await getReportView(user.id, v.reportId!))).toBe(false);
      expect(await db.select().from(refunds).where(eq(refunds.orderId, orderId))).toHaveLength(0);
    });

    it("an order already past its deadline is not generated at all; the overdue refund takes it", async () => {
      const { user, orderId } = await paid("r3-overdue@example.com");
      await db.update(orders).set({ refundDueAt: new Date(Date.now() - 1000) }).where(eq(orders.id, orderId));
      expect(await generateReport(orderId)).toBe("skipped");
      expect((await orderRow(orderId)).generationCalls).toBe(0);
      expect(await refundOverdueOrders()).toBe(1);
      await drainJobs();
      expect((await getOrderView(user.id, orderId)).status).toBe("refunded");
    });
  });
});

// ---------------------------------------------------------------- P1 · notifications

/** 模拟 Resend：同一幂等键只投递一封；可以让下一次"已受理但响应丢失" */
function resendLike() {
  const inbox = new Map<string, MailMessage>();
  let calls = 0;
  let loseNext = false;
  const mailer: Mailer = {
    async send(m) {
      // 登录验证码照常进测试收件箱（login 从这里读码）；只模拟带幂等键的通知邮件
      if (!m.idempotencyKey) return void sentMail.push(m);
      calls++;
      const key = m.idempotencyKey ?? crypto.randomUUID();
      if (!inbox.has(key)) inbox.set(key, m);
      if (loseNext) {
        loseNext = false;
        throw new Error("socket hang up (accepted by the mail service)");
      }
    },
  };
  return { mailer, inbox, calls: () => calls, loseNext: () => void (loseNext = true) };
}

describe("P1 · notifications separate 'claimed' from 'accepted by the mail service'", () => {
  it("reclaims a claim left by a run that died before sending, and defers while a live claim is held", async () => {
    const mail = resendLike();
    __setMailerForTests(mail.mailer);
    const d = await delivered("r3-claim@example.com");
    // 交付通知已发（由 drainJobs 完成）；构造"认领后进程退出"的现场
    await db.update(orders).set({ readyNotifiedAt: null, readyNotifyClaimedAt: new Date() }).where(eq(orders.id, d.orderId));
    const before = mail.calls();
    // 认领仍有效：任务延后，不消耗重试次数，也不发信
    const { enqueue } = await import("@/server/jobs/queue");
    await enqueue(db, "send_report_ready_email", { orderId: d.orderId }, { dedupeKey: `r3-ready:${d.orderId}:1` });
    await drainJobs();
    const [job] = await db.select().from(jobs).where(eq(jobs.dedupeKey, `r3-ready:${d.orderId}:1`));
    expect(job).toMatchObject({ status: "queued", attempts: 0 });
    expect(job!.lastError).toContain("claimed");
    expect(mail.calls()).toBe(before);
    // 认领过期（进程早已退出）：重新认领并用同一幂等键发送
    await db.update(orders).set({ readyNotifyClaimedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(orders.id, d.orderId));
    await makeJobsDue();
    await drainJobs();
    const o = await orderRow(d.orderId);
    expect(o.readyNotifiedAt).not.toBeNull();
    expect(o.readyNotifyClaimedAt).toBeNull();
    expect(mail.calls() - before).toBe(1);
    expect([...mail.inbox.keys()].filter((k) => k === `ready-mail:${d.orderId}`)).toHaveLength(1);
    __setMailerForTests(defaultMailer);
  });

  it("an email accepted by the service whose response was lost is resent with the same key and delivered once", async () => {
    const mail = resendLike();
    __setMailerForTests(mail.mailer);
    mail.loseNext();
    const d = await delivered("r3-lostmail@example.com");
    let o = await orderRow(d.orderId);
    expect(o.readyNotifiedAt).toBeNull(); // 没拿到"已接受"，不记已通知
    expect(o.readyNotifyClaimedAt).toBeNull(); // 认领已释放，交给重试
    await makeJobsDue();
    await drainJobs();
    o = await orderRow(d.orderId);
    expect(o.readyNotifiedAt).not.toBeNull();
    expect(mail.calls()).toBe(2);
    expect([...mail.inbox.values()].filter((m) => m.subject.includes("报告已生成"))).toHaveLength(1);

    // 工单通知同理
    const t = await submitTicket(
      { idempotencyKey: "r3-ticket-lost-1", category: "other", reportIssues: [], description: "页面打不开了怎么办", includeQuestion: false, diagnostics: {} },
      { user: null, ip: "10.0.0.31" },
    );
    const [row] = await db.select().from(supportTickets).where(eq(supportTickets.ticketNo, t.ticketNo));
    mail.loseNext();
    await expect(notifySupportTicket(row!.id)).rejects.toThrow(/socket hang up/);
    expect((await db.select().from(supportTickets).where(eq(supportTickets.id, row!.id)))[0]!.notifiedAt).toBeNull();
    await notifySupportTicket(row!.id);
    expect((await db.select().from(supportTickets).where(eq(supportTickets.id, row!.id)))[0]!.notifiedAt).not.toBeNull();
    expect([...mail.inbox.keys()].filter((k) => k === `ticket-notify:${row!.id}`)).toHaveLength(1);
    await drainJobs();
    __setMailerForTests(defaultMailer);
  });

  it("does nothing for an order that is already notified", async () => {
    const d = await delivered("r3-notified@example.com");
    const before = sentMail.length;
    await sendReportReadyEmail(d.orderId);
    expect(sentMail.length).toBe(before);
  });
});

// ---------------------------------------------------------------- P1 · deletion vs late write-backs

describe("P1 · after deletion, late results cannot write cleared content back", () => {
  it("drops a triage result that finishes after the reading was deleted", async () => {
    const d = await delivered("r3-late-triage@example.com");
    await uploadReading(d.user.id, {
      clientReadingId: d.clientReadingId,
      question: "要不要接下这个外包项目？预算只有一半。",
      topicId: "career",
      topicOriginal: "career",
      context: {},
      tosses: tossesFor([9, 7, 7, 7, 7, 7]),
      consent: true,
    });
    const base = getLlm();
    __setLlmForTests({
      ...base,
      name: "fake",
      generateStructured: async (req: StructuredRequest) => {
        if (req.route === "triage") await deleteReport(d.user.id, d.reportId); // 分流进行中，用户删除了这一卦
        return base.generateStructured(req);
      },
    } as LlmProvider);
    await expect(runTriage(d.user.id, d.readingId)).rejects.toMatchObject({ status: 409 });
    __setLlmForTests(null);
    const rows = await db.select().from(triageResults).where(eq(triageResults.readingId, d.readingId));
    expect(rows.every((t) => t.outputCt === null)).toBe(true);
  });

  it("a ticket submitted after the report was deleted carries no question, even when asked to attach it", async () => {
    const d = await delivered("r3-ticket-delete@example.com");
    await deleteReport(d.user.id, d.reportId);
    await submitTicket(
      { idempotencyKey: "r3-ticket-after-delete", category: "report_content", reportIssues: [], description: "删除后还想反馈一下", includeQuestion: true, orderId: d.orderId, diagnostics: {} },
      { user: { id: d.user.id, email: d.user.email }, ip: "10.0.0.32" },
    );
    const [t] = await db.select().from(supportTickets).where(eq(supportTickets.idempotencyKey, "r3-ticket-after-delete"));
    expect(t).toMatchObject({ orderId: d.orderId, questionCt: null });
  });
});
