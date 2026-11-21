/**
 * 第二轮验收（技术方案附录 E）：
 * P0-1 确认版本与报价绑定 Checkout；P0-2 退款失败可发现、可恢复、可核对；P0-3 删除、追问与任务恢复的并发一致性。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { __setEnvForTests, type Env } from "@/server/env";
import type { DB } from "@/server/db/client";
import { followups, jobs, opsActions, orders, paymentEvents, readings, refunds, reports, supportTickets } from "@/server/db/schema";
import { claimNext, completeJob, enqueue, requeueStale } from "@/server/jobs/queue";
import { drainJobs, runMaintenance } from "@/server/jobs/runner";
import { __setMailerForTests } from "@/server/mail";
import { listOrderExceptions } from "@/server/ops";
import { createOrderForReading, getOrderView, handlePaymentEvent } from "@/server/orders";
import { __setPaymentProviderForTests, getPaymentProvider, type PaymentProvider } from "@/server/payments";
import { __fakeCheckoutCreates, __setFakeRefundBehavior, completeFakeCheckout, getFakeSession, signFakeEvent } from "@/server/payments/fake";
import { readIntent } from "@/server/snapshot";
import { uploadReading } from "@/server/readings";
import { retryRefundByOps } from "@/server/refunds";
import { generateFollowup, onFollowupJobExhausted } from "@/server/report/generate";
import { deleteReport, getReportView, sendReportReadyEmail, submitFollowup } from "@/server/report/service";
import { submitTicket } from "@/server/support";
import { runTriage } from "@/server/triage";
import { confirmation, login, sentMail, setupTestServer, tossesFor } from "./helpers";

const BASE: Partial<Env> = { PGLITE_DIR: "memory", APP_URL: "http://localhost:3000", SALES_ENABLED: true, ALLOW_UNREVIEWED_CONTENT: true };
const setEnv = (o: Partial<Env> = {}) => __setEnvForTests({ ...BASE, ...o });

let db: DB;
beforeAll(async () => {
  db = await setupTestServer(BASE);
});

let n = 0;
async function triaged(user: { id: string }, question = "要不要接下这个外包项目？") {
  const clientReadingId = `round2-${++n}-xxxxxxxx`;
  const r = await uploadReading(user.id, {
    clientReadingId,
    question,
    topicId: "career",
    topicOriginal: "career",
    context: {},
    tosses: tossesFor([9, 7, 7, 7, 7, 7]),
    consent: true,
  });
  const t = await runTriage(user.id, r.readingId);
  return { ...r, clientReadingId, triage: t };
}

async function pay(orderId: string) {
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  const { body, signature } = completeFakeCheckout(o!.providerSessionId!);
  return handlePaymentEvent(getPaymentProvider().parseWebhook(body, new Headers({ "x-fake-signature": signature })));
}

function signed(e: Record<string, unknown>) {
  const body = JSON.stringify(e);
  return getPaymentProvider().parseWebhook(body, new Headers({ "x-fake-signature": signFakeEvent(body) }));
}

async function delivered(user: { id: string; email: string }) {
  const r = await triaged(user);
  const { orderId } = await createOrderForReading(user, await confirmation(r.readingId));
  await pay(orderId);
  await drainJobs();
  return { ...r, orderId, reportId: (await getOrderView(user.id, orderId)).reportId! };
}

// ---------------------------------------------------------------- P0-1

describe("P0-1 · the confirmed intent and price are bound to the checkout", () => {
  it("rejects a stale page after the question changed elsewhere, then accepts the re-confirmed intent", async () => {
    const user = await login("stale@example.com");
    const r = await triaged(user);
    const seen = await confirmation(r.readingId); // 旧页面上用户确认的版本
    // 另一个标签页改了问题并重新确认题意
    await uploadReading(user.id, {
      clientReadingId: r.clientReadingId,
      question: "要不要接下这个外包项目？对方只给一半预算。",
      topicId: "career",
      topicOriginal: "career",
      context: {},
      tosses: tossesFor([9, 7, 7, 7, 7, 7]),
      consent: true,
    });
    const t2 = await runTriage(user.id, r.readingId);
    const err = await createOrderForReading(user, seen).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: "intent_changed", details: { revision: t2.revision, triageId: t2.triageId } });

    const { orderId } = await createOrderForReading(user, await confirmation(r.readingId));
    const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
    // 冻结的题意就是用户最后确认、页面展示的那一版
    expect(readIntent(o!)?.question).toBe("要不要接下这个外包项目？对方只给一半预算。");
    expect(readIntent(o!)?.summary).toBe(t2.summary);
    expect(o!.readingRevision).toBe(t2.revision);
    expect(o!.triageResultId).toBe(t2.triageId);
  });

  it("rejects a stale price and charges exactly the confirmed offer", async () => {
    const user = await login("price@example.com");
    const r = await triaged(user);
    const seen = await confirmation(r.readingId);
    setEnv({ PRICE_VERSION: "price@2026-12", PRICE_AMOUNT_MINOR: 1290 });
    await expect(createOrderForReading(user, seen)).rejects.toMatchObject({ status: 409, code: "price_changed", details: { priceVersion: "price@2026-12:1290:usd" } });
    const { orderId } = await createOrderForReading(user, await confirmation(r.readingId));
    const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(o!.amountMinor).toBe(1290);
    expect(getFakeSession(o!.providerSessionId!)?.amountMinor).toBe(1290);
    setEnv();
  });

  it("reuses one order and one Checkout for concurrent clicks on the same confirmation", async () => {
    const user = await login("clicks@example.com");
    const r = await triaged(user);
    const input = await confirmation(r.readingId);
    const before = __fakeCheckoutCreates();
    const results = await Promise.all(Array.from({ length: 5 }, () => createOrderForReading(user, input)));
    expect(new Set(results.map((x) => x.orderId)).size).toBe(1);
    expect(new Set(results.map((x) => x.checkoutUrl)).size).toBe(1);
    expect(__fakeCheckoutCreates() - before).toBe(1);
    const pending = await db.select().from(orders).where(and(eq(orders.readingId, r.readingId), eq(orders.status, "pending_payment")));
    expect(pending).toHaveLength(1);
  });

  it("keeps the order when the payment provider times out, and the retry reuses it", async () => {
    const user = await login("timeout@example.com");
    const r = await triaged(user);
    const real = getPaymentProvider();
    let fail = true;
    __setPaymentProviderForTests({
      ...real,
      name: "fake",
      createCheckout: async (i) => {
        if (fail) {
          fail = false;
          throw new Error("ETIMEDOUT");
        }
        return real.createCheckout(i);
      },
    } as PaymentProvider);
    const input = await confirmation(r.readingId);
    await expect(createOrderForReading(user, input)).rejects.toMatchObject({ status: 503, code: "payment_unavailable" });
    const [kept] = await db.select().from(orders).where(eq(orders.readingId, r.readingId));
    expect(kept!.status).toBe("pending_payment");
    expect(kept!.providerSessionId).toBeNull();
    const retry = await createOrderForReading(user, input);
    expect(retry.orderId).toBe(kept!.id);
    expect(retry.checkoutUrl).toBeTruthy();
    __setPaymentProviderForTests(null);
  });

  it("delivers a payment whose session id was never written back, using the provider's order metadata", async () => {
    const user = await login("unlinked@example.com");
    const r = await triaged(user);
    const { orderId } = await createOrderForReading(user, await confirmation(r.readingId));
    const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
    await db.update(orders).set({ providerSessionId: null }).where(eq(orders.id, orderId)); // 写回前中断
    const { body, signature } = completeFakeCheckout(o!.providerSessionId!);
    await handlePaymentEvent(getPaymentProvider().parseWebhook(body, new Headers({ "x-fake-signature": signature })));
    await drainJobs();
    expect((await getOrderView(user.id, orderId)).status).toBe("delivered");
  });

  it("asks for a retry (and does not mark the event processed) when no order matches a paid checkout", async () => {
    const ev = signed({ id: "evt_orphan_checkout", type: "checkout.completed", sessionId: "fake_cs_missing" });
    const provider = getPaymentProvider();
    __setPaymentProviderForTests({
      ...provider,
      name: "fake",
      retrieveCheckout: async () => ({ sessionId: "fake_cs_missing", status: "complete", paid: true, amountMinor: 990, currency: "usd", paymentId: "pi_x", orderId: null, attemptId: null, expiresAt: null, url: null }),
    } as PaymentProvider);
    await expect(handlePaymentEvent(ev)).rejects.toMatchObject({ status: 503 });
    const [row] = await db.select().from(paymentEvents).where(eq(paymentEvents.eventId, "evt_orphan_checkout"));
    expect(row!.processedAt).toBeNull();
    __setPaymentProviderForTests(null);
  });
});

// ---------------------------------------------------------------- P0-2

describe("P0-2 · refunds can fail, be found, be retried safely and reconciled", () => {
  it("records the provider refund id, status and confirmed amount for an async refund", async () => {
    __setFakeRefundBehavior("succeed_async");
    const user = await login("async-refund@example.com");
    const r = await triaged(user);
    const first = await createOrderForReading(user, await confirmation(r.readingId));
    // 第二个标签页在报价版本更新后重新确认：另一笔订单
    setEnv({ PRICE_VERSION: "price@second-tab" });
    const second = await createOrderForReading(user, await confirmation(r.readingId));
    setEnv();
    await pay(first.orderId);
    await pay(second.orderId);
    await drainJobs();
    const [att] = await db.select().from(refunds).where(eq(refunds.orderId, second.orderId));
    expect(att).toMatchObject({ attemptNo: 1, status: "succeeded", amountMinor: 990, currency: "usd", idempotencyKey: `refund:${second.orderId}:${att!.id}` });
    expect(att!.providerRefundId).toMatch(/^fake_re_/);
    const v = await getOrderView(user.id, second.orderId);
    expect(v).toMatchObject({ status: "refunded", refundedAmountMinor: 990 });
    // 原订单仍可读、可追问
    const original = await getOrderView(user.id, first.orderId);
    expect(original.status).toBe("delivered");
    await submitFollowup(user.id, original.reportId!, "访谈对象从哪里找？", "r2-dup-fu");
    await drainJobs();
    const rep = await getReportView(user.id, original.reportId!);
    if ("deleted" in rep) throw new Error("original report unavailable");
    expect(rep.followups[0]?.status).toBe("done");
  });

  it("moves a confirmed refund failure to refund_failed, shows it to ops, and retries safely after verification", async () => {
    const user = await login("refund-fail@example.com");
    const { orderId } = await delivered(user);
    __setFakeRefundBehavior("fail_async");
    const { requestRefundByOps } = await import("@/server/orders");
    await requestRefundByOps(orderId, "complaint", "ops@example.com");
    await drainJobs();
    let v = await getOrderView(user.id, orderId);
    expect(v.status).toBe("refund_failed");
    expect(v.reviewReason).toBe("refund_failed");
    // 异常单自动进入运营列表，不需要用户提工单
    const list = await listOrderExceptions(orderId.slice(0, 8));
    expect(list.find((x) => x.id === orderId)?.refunds[0]).toMatchObject({ attemptNo: 1, status: "failed" });

    // 同一次尝试的自动重试不会新开退款
    await runMaintenance();
    await drainJobs();
    expect(await db.select().from(refunds).where(eq(refunds.orderId, orderId))).toHaveLength(1);

    __setFakeRefundBehavior("succeed_async");
    const msg = await retryRefundByOps(orderId, "ops@example.com", "card issuer fixed");
    expect(msg).toContain("新的退款尝试");
    // 新尝试有自己的幂等键和任务去重键，不会被旧的失败任务挡住
    const atts = await db.select().from(refunds).where(eq(refunds.orderId, orderId));
    expect(new Set(atts.map((a) => a.idempotencyKey)).size).toBe(2);
    for (const a of atts) expect(a.idempotencyKey).toBe(`refund:${orderId}:${a.id}`);
    await drainJobs();
    v = await getOrderView(user.id, orderId);
    expect(v).toMatchObject({ status: "refunded", refundedAmountMinor: 990 });
    const acts = await db.select().from(opsActions).where(eq(opsActions.orderId, orderId));
    expect(acts.map((a) => `${a.actor}:${a.action}:${a.result}`)).toEqual(
      expect.arrayContaining(["ops@example.com:refund:requested", "ops@example.com:retry_refund:requested"]),
    );
  });

  it("does not open a new attempt when the provider says the 'failed' refund actually went through", async () => {
    const user = await login("refund-verify@example.com");
    const { orderId } = await delivered(user);
    __setFakeRefundBehavior("pending");
    const { requestRefundByOps } = await import("@/server/orders");
    await requestRefundByOps(orderId, "complaint", "ops@example.com");
    await drainJobs();
    const [att] = await db.select().from(refunds).where(eq(refunds.orderId, orderId));
    // 本地误记为失败，但支付方仍在处理
    await db.update(refunds).set({ status: "failed" }).where(eq(refunds.id, att!.id));
    const msg = await retryRefundByOps(orderId, "ops@example.com", "check");
    expect(msg).toContain("已同步状态");
    expect(await db.select().from(refunds).where(eq(refunds.orderId, orderId))).toHaveLength(1);
    __setFakeRefundBehavior("succeed_async");
  });

  it("ignores replayed refund callbacks and records partial refunds from the provider's numbers", async () => {
    const user = await login("refund-replay@example.com");
    const { orderId, reportId } = await delivered(user);
    const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
    const partial = signed({ id: "evt_partial_1", type: "refund.updated", refundId: "re_ext_1", paymentId: o!.providerPaymentId, status: "succeeded", amountMinor: 400, currency: "usd", failureReason: null });
    expect(await handlePaymentEvent(partial)).toBe("processed");
    expect(await handlePaymentEvent(partial)).toBe("duplicate");
    const v = await getOrderView(user.id, orderId);
    expect(v).toMatchObject({ status: "delivered", refundedAmountMinor: 400, reviewReason: "partial_refund" });
    // 在支付方后台发起的退款也有本地记录
    const [ext] = await db.select().from(refunds).where(eq(refunds.providerRefundId, "re_ext_1"));
    expect(ext).toMatchObject({ requestedBy: "provider", status: "succeeded", amountMinor: 400 });
    expect("deleted" in (await getReportView(user.id, reportId))).toBe(false);
  });

  it("reconciles a long-pending refund and adopts legacy refund_pending orders with their original key", async () => {
    const user = await login("refund-recon@example.com");
    const { orderId } = await delivered(user);
    __setFakeRefundBehavior("pending");
    const { requestRefundByOps } = await import("@/server/orders");
    await requestRefundByOps(orderId, "complaint", "ops@example.com");
    await drainJobs();
    const [att] = await db.select().from(refunds).where(eq(refunds.orderId, orderId));
    expect(att!.status).toBe("pending");
    const { __settleFakeRefund } = await import("@/server/payments/fake");
    __settleFakeRefund(att!.providerRefundId!, "succeeded");
    const { fakeRefundEvents } = await import("@/server/payments/fake");
    fakeRefundEvents.splice(0); // 回调丢失，只能靠对账
    await db.update(refunds).set({ updatedAt: new Date(Date.now() - 20 * 60_000) }).where(eq(refunds.id, att!.id));
    await runMaintenance();
    expect((await getOrderView(user.id, orderId)).status).toBe("refunded");

    // 迁移前遗留：refund_pending 但没有尝试记录
    __setFakeRefundBehavior("succeed_async");
    const legacy = await delivered(user);
    await db.update(orders).set({ status: "refund_pending" }).where(eq(orders.id, legacy.orderId));
    await runMaintenance();
    await drainJobs();
    const [la] = await db.select().from(refunds).where(eq(refunds.orderId, legacy.orderId));
    expect(la!.idempotencyKey).toBe(`refund:${legacy.orderId}`);
    expect((await getOrderView(user.id, legacy.orderId)).status).toBe("refunded");
  });
});

// ---------------------------------------------------------------- P0-3

describe("P0-3 · deletion, follow-ups and job recovery stay consistent under concurrency", () => {
  it("drops a follow-up answer that finishes after the report was deleted, without touching the credits", async () => {
    const user = await login("del-race@example.com");
    const { orderId, reportId } = await delivered(user);
    const q = await submitFollowup(user.id, reportId, "第一个追问", "del-race-1");
    if (q.status !== "queued") throw new Error("not queued");
    await deleteReport(user.id, reportId);
    await generateFollowup(q.followupId);
    const [f] = await db.select().from(followups).where(eq(followups.id, q.followupId));
    expect(f!.status).toBe("canceled");
    expect(f!.answerCt).toBeNull();
    const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(o!.followupsUsed).toBe(1);
    await expect(submitFollowup(user.id, reportId, "再问一次", "del-race-2")).rejects.toMatchObject({ code: "report_unavailable" });
  });

  it("returns a failed follow-up's credit exactly once even if settlement runs twice", async () => {
    const user = await login("double-settle@example.com");
    const { orderId, reportId } = await delivered(user);
    const q = await submitFollowup(user.id, reportId, "一个会失败的追问", "dbl-1");
    if (q.status !== "queued") throw new Error("not queued");
    await onFollowupJobExhausted(q.followupId);
    await onFollowupJobExhausted(q.followupId);
    await generateFollowup(q.followupId); // 晚到的旧执行者
    const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(o!.followupsUsed).toBe(0);
    const [f] = await db.select().from(followups).where(eq(followups.id, q.followupId));
    expect(f!.status).toBe("failed");
  });

  it("ignores the stale worker's completion after its lease was taken over", async () => {
    await enqueue(db, "send_report_ready_email", { orderId: "00000000-0000-4000-8000-00000000000a" }, { dedupeKey: "lease-test" });
    let first = await claimNext(db);
    while (first && first.kind !== "send_report_ready_email") first = await claimNext(db);
    expect(first).not.toBeNull();
    await db.update(jobs).set({ lockedAt: new Date(Date.now() - 60_000) }).where(eq(jobs.id, first!.id));
    expect(await requeueStale(db, 1000)).toBeGreaterThan(0);
    const second = await claimNext(db);
    expect(second?.id).toBe(first!.id);
    expect(second!.lockToken).not.toBe(first!.lockToken);
    expect(await completeJob(db, first!)).toBe(false); // 旧执行者
    const [still] = await db.select().from(jobs).where(eq(jobs.id, first!.id));
    expect(still!.status).toBe("running");
    expect(await completeJob(db, second!)).toBe(true);
  });

  it("sends the ready email once even when the job runs twice", async () => {
    const user = await login("mail-once@example.com");
    const { orderId } = await delivered(user);
    const count = () => sentMail.filter((m) => m.to === "mail-once@example.com" && m.subject.includes("报告已生成")).length;
    const before = count();
    await sendReportReadyEmail(orderId);
    await sendReportReadyEmail(orderId);
    expect(count()).toBe(before); // 交付时已发过一次，重复执行不再发
    expect(before).toBe(1);
  });

  it("clears the attached question on tickets when the report is deleted, keeping the ticket", async () => {
    const user = await login("ticket-del@example.com");
    const { reportId } = await delivered(user);
    const t = await submitTicket(
      { idempotencyKey: "ticket-del-1", category: "report_content", reportIssues: ["misunderstood"], description: "报告误解了题意", reportId, includeQuestion: true, diagnostics: {} },
      { user, ip: "4.4.4.4" },
    );
    await deleteReport(user.id, reportId);
    const [row] = await db.select().from(supportTickets).where(eq(supportTickets.ticketNo, t.ticketNo));
    expect(row!.questionCt).toBeNull();
    expect(row!.descriptionCt).not.toBeNull();
  });

  it("closes the reading's open Checkout on delete, and refunds a payment that was already in flight", async () => {
    const user = await login("del-checkout@example.com");
    const r = await triaged(user);
    const { orderId } = await createOrderForReading(user, await confirmation(r.readingId));
    // 另一卦已交付的报告用来触发删除；这里直接删除本卦：先造一个交付后的报告
    const other = await delivered(user);
    const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
    // 删除另一卦不影响这一卦的结账
    await deleteReport(user.id, other.reportId);
    expect(getFakeSession(o!.providerSessionId!)?.status).toBe("open");

    // 本卦：用户付款与删除同时发生——支付方已完成，本地还没收到回调
    completeFakeCheckout(o!.providerSessionId!);
    await db.transaction(async (tx) => {
      const { revokeOrderContent, purgeReading } = await import("@/server/orders");
      await revokeOrderContent(tx, orderId, "user_deleted");
      await tx.update(orders).set({ status: "expired" }).where(eq(orders.id, orderId));
      await enqueue(tx, "expire_checkout", { orderId }, { dedupeKey: `expire:${orderId}` });
      await purgeReading(tx, r.readingId);
    });
    await drainJobs();
    const v = await getOrderView(user.id, orderId);
    expect(v.status).toBe("refunded");
    expect(await db.select().from(reports).where(eq(reports.orderId, orderId))).toHaveLength(0);
  });

  it("deleteReport closes an older open Checkout of the same reading (e.g. from a second tab)", async () => {
    const user = await login("del-tab@example.com");
    const r = await triaged(user);
    const tabA = await createOrderForReading(user, await confirmation(r.readingId)); // 第一个标签页，未付款
    setEnv({ PRICE_VERSION: "price@tab-b" }); // 第二个标签页确认时报价已更新 → 新的确认、新的尝试
    const tabB = await createOrderForReading(user, await confirmation(r.readingId));
    setEnv();
    expect(tabB.orderId).not.toBe(tabA.orderId);
    await pay(tabB.orderId);
    await drainJobs();
    const reportId = (await getOrderView(user.id, tabB.orderId)).reportId!;
    const [a] = await db.select().from(orders).where(eq(orders.id, tabA.orderId));
    await deleteReport(user.id, reportId);
    await drainJobs();
    expect((await getOrderView(user.id, tabA.orderId)).status).toBe("expired");
    expect(getFakeSession(a!.providerSessionId!)?.status).toBe("expired");
  });

  it("keeps legacy delivered reports readable; follow-ups resume only when the original intent is recoverable", async () => {
    const user = await login("legacy-fu@example.com");
    // 旧订单 A：阅读在交付后改过 → 报告可读，追问不可用
    const a = await delivered(user);
    await db.update(orders).set({ basis: null, intentCt: null, deliveredAt: new Date(Date.now() - 3600_000) }).where(eq(orders.id, a.orderId));
    await db.update(readings).set({ updatedAt: new Date() }).where(eq(readings.id, a.readingId));
    // 旧订单 B：阅读未改过 → 补建快照，追问可用
    const b = await delivered(user);
    await db.update(orders).set({ basis: null, intentCt: null, deliveredAt: new Date(Date.now() + 1000) }).where(eq(orders.id, b.orderId));
    await runMaintenance();

    expect("deleted" in (await getReportView(user.id, a.reportId))).toBe(false);
    await expect(submitFollowup(user.id, a.reportId, "还能追问吗", "legacy-a")).rejects.toMatchObject({ code: "followups_unavailable" });
    expect((await db.select().from(orders).where(eq(orders.id, a.orderId)))[0]!.reviewReason).toBe("legacy_followups_unavailable");

    const q = await submitFollowup(user.id, b.reportId, "还能追问吗", "legacy-b");
    expect(q.status).toBe("queued");
    await drainJobs();
    const rep = await getReportView(user.id, b.reportId);
    if ("deleted" in rep) throw new Error("deleted");
    expect(rep.followups[0]?.status).toBe("done");
    __setMailerForTests({ send: async (m) => void sentMail.push(m) });
  });
});
