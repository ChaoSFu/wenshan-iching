import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, notInArray, sql } from "drizzle-orm";
import { getDb, type DB } from "./db/client";
import { followups, jobs, orders, paymentEvents, readings, reports, triageResults, type OrderStatus } from "./db/schema";
import { decryptJson } from "./crypto";
import { env } from "./env";
import { HttpError } from "./http";
import { enqueue } from "./jobs/queue";
import { assertContentApproved, assertSalesOpen, getOffer } from "./offer";
import { fakeRefundEvents } from "./payments/fake";
import { getPaymentProvider, type CheckoutState, type PaymentEvent } from "./payments";
import { loadOwnedReading, toPlain } from "./readings";
import { buildSnapshot, snapshotColumns } from "./snapshot";
import { TRIAGE_VERSION, requirePurchasableTriage, type TriageOutput } from "./triage";

/**
 * 订单状态机（技术方案 5.9）：
 * pending_payment → paid → generating → delivered
 *                 ↘ expired            ↘ generation_failed → refund_pending → refunded
 * paid 但金额/币种异常、旧订单无法还原题意 → needs_review（运营核实）
 * delivered → refunded / disputed（按订单撤回访问）
 */

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/** 视为"已经有一笔有效付款"的状态（每次起卦最多一笔，见唯一索引） */
const PAID_STATES: OrderStatus[] = ["paid", "generating", "delivered", "generation_failed"];
/** 订单仍有效、可能还需要原始阅读数据的状态 */
const ACTIVE_STATES: OrderStatus[] = ["paid", "generating", "delivered", "generation_failed", "needs_review"];

export interface OrderView {
  id: string;
  status: OrderStatus;
  amountMinor: number;
  currency: string;
  createdAt: string;
  paidAt: string | null;
  deliveredAt: string | null;
  refundDueAt: string | null;
  refundedAt: string | null;
  refundedAmountMinor: number;
  failureReason: string | null;
  reviewReason: string | null;
  checkoutUrl: string | null;
  reportId: string | null;
  clientReadingId: string;
  followupsRemaining: number;
}

export async function createOrderForReading(
  user: { id: string; email: string },
  readingId: string,
): Promise<{ orderId: string; checkoutUrl: string | null }> {
  const offer = assertSalesOpen();
  const reading = await loadOwnedReading(user.id, readingId);
  const db = await getDb();

  // 同一卦已有有效付款：直接回到那笔订单（编辑问题不会产生第二份报告）
  const existing = await db
    .select()
    .from(orders)
    .where(and(eq(orders.readingId, reading.id), eq(orders.userId, user.id)))
    .orderBy(desc(orders.createdAt));
  const paid = existing.find((o) => PAID_STATES.includes(o.status) || o.status === "needs_review");
  if (paid) return { orderId: paid.id, checkoutUrl: null };

  const triage = await requirePurchasableTriage(reading);
  assertContentApproved(reading.cast, reading.topicId);

  // 复用同一题意修订、同一分流结果下未过期的结账，避免重复付款（PRD §4）
  const open = existing.find(
    (o) =>
      o.status === "pending_payment" &&
      o.readingRevision === reading.revision &&
      o.triageResultId === triage.id &&
      o.checkoutUrl &&
      o.checkoutExpiresAt &&
      o.checkoutExpiresAt.getTime() > Date.now() + 2 * 60_000,
  );
  if (open) return { orderId: open.id, checkoutUrl: open.checkoutUrl };

  const snapshot = buildSnapshot(reading, { id: triage.id, version: TRIAGE_VERSION, output: triage.output }, { includeUnreviewed: !offer.reviewRequired });
  if (snapshot.missing.length) throw new HttpError(409, "content_pending", "这一卦有原文仍在补录，暂时不能购买");

  const provider = getPaymentProvider();
  const [order] = await db
    .insert(orders)
    .values({
      userId: user.id,
      readingId: reading.id,
      amountMinor: offer.amountMinor,
      currency: offer.currency,
      priceVersion: offer.priceVersion,
      provider: provider.name,
      ...snapshotColumns(snapshot),
    })
    .returning();

  const session = await provider.createCheckout({
    orderId: order!.id,
    amountMinor: order!.amountMinor,
    currency: order!.currency,
    email: user.email,
    description: "问山解读报告（含三次追问）",
    successUrl: `${env().APP_URL}/orders/${order!.id}?from=checkout`,
    cancelUrl: `${env().APP_URL}/r/${reading.clientReadingId}`,
    idempotencyKey: `checkout:${order!.id}`,
  });
  await db
    .update(orders)
    .set({ providerSessionId: session.sessionId, checkoutUrl: session.url, checkoutExpiresAt: session.expiresAt, updatedAt: new Date() })
    .where(eq(orders.id, order!.id));
  return { orderId: order!.id, checkoutUrl: session.url };
}

/**
 * 收到付款：核对金额、币种后把订单置为已支付，并在同一事务里入队生成任务。
 * 条件更新保证同一笔付款只发一次货；webhook、成功页、对账任务都调用这里。
 */
export async function markPaid(
  state: CheckoutState,
): Promise<"paid" | "duplicate" | "noop" | "needs_review" | "not_paid" | "unknown"> {
  if (state.status !== "complete" || !state.paid) return "not_paid";
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.providerSessionId, state.sessionId)).for("update").limit(1);
    if (!order) return "unknown";
    if (order.status !== "pending_payment" && order.status !== "expired") return "noop";
    const now = new Date();

    // 金额或币种异常：收到了钱但不能自动发货，进入可追踪的待处理状态
    if (state.amountMinor !== order.amountMinor || state.currency?.toLowerCase() !== order.currency.toLowerCase()) {
      console.error(`[orders] amount/currency mismatch for order ${order.id}`);
      await tx
        .update(orders)
        .set({ status: "needs_review", reviewReason: "amount_mismatch", paidAt: now, providerPaymentId: state.paymentId, updatedAt: now })
        .where(eq(orders.id, order.id));
      return "needs_review";
    }
    // 旧订单没有题意快照，又无法从当前数据准确还原：交给运营
    if (!order.basis || !order.intentCt) {
      await tx
        .update(orders)
        .set({ status: "needs_review", reviewReason: "legacy_intent_unrecoverable", paidAt: now, providerPaymentId: state.paymentId, updatedAt: now })
        .where(eq(orders.id, order.id));
      return "needs_review";
    }

    const [other] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.readingId, order.readingId), ne(orders.id, order.id), inArray(orders.status, PAID_STATES)))
      .limit(1);
    if (other) {
      // 同一卦付了两次（例如开了两个标签页）：第二笔自动退款，原订单不受影响
      await tx
        .update(orders)
        .set({ status: "refund_pending", paidAt: now, providerPaymentId: state.paymentId, failureReason: "duplicate_payment", updatedAt: now })
        .where(eq(orders.id, order.id));
      await enqueue(tx, "refund_order", { orderId: order.id, reason: "duplicate_payment" }, { dedupeKey: `refund:${order.id}` });
      return "duplicate";
    }

    await tx
      .update(orders)
      .set({
        status: "paid",
        paidAt: now,
        providerPaymentId: state.paymentId,
        refundDueAt: new Date(now.getTime() + env().REFUND_AFTER_HOURS * 3600_000),
        updatedAt: now,
      })
      .where(eq(orders.id, order.id));
    await enqueue(tx, "generate_report", { orderId: order.id }, { dedupeKey: `report:${order.id}` });
    return "paid";
  });
}

async function expireCheckout(sessionId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(orders)
    .set({ status: "expired", updatedAt: new Date() })
    .where(and(eq(orders.providerSessionId, sessionId), eq(orders.status, "pending_payment")));
}

/**
 * 按订单撤回：清除这笔订单的报告、追问和题意快照里的个人内容，账务字段保留。
 * 同一卦的其他订单不受影响（重复付款退款不能波及原订单）。
 */
export async function revokeOrderContent(tx: Tx, orderId: string, reason: string): Promise<void> {
  const now = new Date();
  await tx
    .update(reports)
    .set({ contentCt: null, citationsSnapshotCt: null, deletedAt: now, deleteReason: reason })
    .where(and(eq(reports.orderId, orderId), isNull(reports.deletedAt)));
  await tx.update(followups).set({ questionCt: null, answerCt: null, updatedAt: now }).where(eq(followups.orderId, orderId));
  await tx.update(orders).set({ intentCt: null, contentPurgedAt: now, updatedAt: now }).where(eq(orders.id, orderId));
}

/** 共享的阅读数据（问题、背景、分流摘要）只在没有任何有效订单还需要它时清除 */
export async function releaseReadingIfUnused(tx: Tx, readingId: string): Promise<boolean> {
  const [active] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.readingId, readingId), inArray(orders.status, ACTIVE_STATES), isNull(orders.contentPurgedAt)))
    .limit(1);
  if (active) return false;
  await purgeReading(tx, readingId);
  return true;
}

export async function purgeReading(tx: Tx, readingId: string): Promise<void> {
  await tx.update(readings).set({ questionCt: null, contextCt: null, deletedAt: new Date() }).where(eq(readings.id, readingId));
  await tx.update(triageResults).set({ outputCt: null }).where(eq(triageResults.readingId, readingId));
}

class PaymentEventNotReady extends HttpError {
  constructor(what: string) {
    // 503：支付平台会稍后重发；那时付款回调多半已处理（回调顺序可能颠倒）
    super(503, "event_not_ready", `no order matches ${what} yet`);
  }
}

async function markRefunded(paymentId: string, amountRefundedMinor: number): Promise<string> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.providerPaymentId, paymentId)).for("update").limit(1);
    if (!order) throw new PaymentEventNotReady(`payment ${paymentId}`);
    if (order.status === "refunded") return order.id;
    const amount = Math.max(order.refundedAmountMinor, amountRefundedMinor);
    if (amount < order.amountMinor) {
      // 部分退款：记账，访问保留，并标记供运营核对
      await tx
        .update(orders)
        .set({ refundedAmountMinor: amount, reviewReason: "partial_refund", updatedAt: new Date() })
        .where(eq(orders.id, order.id));
      return order.id;
    }
    await tx
      .update(orders)
      .set({ status: "refunded", refundedAmountMinor: amount, refundedAt: new Date(), updatedAt: new Date() })
      .where(eq(orders.id, order.id));
    await revokeOrderContent(tx, order.id, "refunded");
    await releaseReadingIfUnused(tx, order.readingId);
    return order.id;
  });
}

async function markDisputed(paymentId: string): Promise<string> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.providerPaymentId, paymentId)).for("update").limit(1);
    if (!order) throw new PaymentEventNotReady(`payment ${paymentId}`);
    await tx.update(orders).set({ status: "disputed", updatedAt: new Date() }).where(eq(orders.id, order.id));
    await revokeOrderContent(tx, order.id, "disputed");
    await releaseReadingIfUnused(tx, order.readingId);
    return order.id;
  });
}

/**
 * 处理一条支付回调（已验签）。事件 id 去重防重放；处理逻辑本身也是幂等的，
 * 处理到一半失败、或回调先于付款到达时，返回错误让支付平台稍后重发。
 */
export async function handlePaymentEvent(event: PaymentEvent): Promise<"processed" | "duplicate"> {
  const db = await getDb();
  const provider = getPaymentProvider();
  await db.insert(paymentEvents).values({ eventId: event.id, provider: provider.name, type: event.type }).onConflictDoNothing();
  const [row] = await db.select().from(paymentEvents).where(eq(paymentEvents.eventId, event.id)).limit(1);
  if (row?.processedAt) return "duplicate";

  let orderId: string | null = null;
  let note: string | null = null;
  switch (event.type) {
    case "checkout.completed": {
      // 以支付平台的查询结果为准，不直接信任回调内容
      const state = await provider.retrieveCheckout(event.sessionId);
      note = await markPaid(state);
      orderId = state.orderId;
      break;
    }
    case "checkout.expired":
      await expireCheckout(event.sessionId);
      break;
    case "refund.succeeded":
      orderId = await markRefunded(event.paymentId, event.amountRefundedMinor);
      break;
    case "dispute.created":
      orderId = await markDisputed(event.paymentId);
      break;
    case "ignored":
      note = event.rawType;
      break;
  }
  await db
    .update(paymentEvents)
    .set({ processedAt: new Date(), orderId: orderId && /^[0-9a-f-]{36}$/.test(orderId) ? orderId : null, note })
    .where(eq(paymentEvents.eventId, event.id));
  return "processed";
}

export async function getOrderView(userId: string, orderId: string): Promise<OrderView> {
  const db = await getDb();
  const [row] = await db
    .select({ order: orders, clientReadingId: readings.clientReadingId, reportId: reports.id, reportDeleted: reports.deletedAt })
    .from(orders)
    .innerJoin(readings, eq(readings.id, orders.readingId))
    .leftJoin(reports, eq(reports.orderId, orders.id))
    .where(and(eq(orders.id, orderId), eq(orders.userId, userId)))
    .limit(1);
  if (!row) throw new HttpError(404, "not_found");
  const o = row.order;
  const checkoutOpen = o.status === "pending_payment" && o.checkoutExpiresAt && o.checkoutExpiresAt.getTime() > Date.now();
  return {
    id: o.id,
    status: o.status,
    amountMinor: o.amountMinor,
    currency: o.currency,
    createdAt: o.createdAt.toISOString(),
    paidAt: o.paidAt?.toISOString() ?? null,
    deliveredAt: o.deliveredAt?.toISOString() ?? null,
    refundDueAt: o.refundDueAt?.toISOString() ?? null,
    refundedAt: o.refundedAt?.toISOString() ?? null,
    refundedAmountMinor: o.refundedAmountMinor,
    failureReason: o.failureReason,
    reviewReason: o.reviewReason,
    checkoutUrl: checkoutOpen ? o.checkoutUrl : null,
    reportId: o.status === "delivered" && row.reportId && !row.reportDeleted ? row.reportId : null,
    clientReadingId: row.clientReadingId,
    followupsRemaining: Math.max(0, o.followupsTotal - o.followupsUsed),
  };
}

/** 支付成功页主动核对一次（Stripe 推荐 webhook 与落地页双路履约） */
export async function confirmOrder(userId: string, orderId: string): Promise<OrderView> {
  const view = await getOrderView(userId, orderId);
  if (view.status === "pending_payment" || view.status === "expired") {
    const db = await getDb();
    const [o] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (o?.providerSessionId) {
      const state = await getPaymentProvider().retrieveCheckout(o.providerSessionId);
      if (state.paid) await markPaid(state);
      else if (state.status === "expired") await expireCheckout(o.providerSessionId);
    }
    return getOrderView(userId, orderId);
  }
  return view;
}

export async function listOrders(userId: string): Promise<OrderView[]> {
  const db = await getDb();
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.userId, userId), ne(orders.status, "pending_payment"), ne(orders.status, "expired")))
    .orderBy(desc(orders.createdAt))
    .limit(100);
  return Promise.all(rows.map((r) => getOrderView(userId, r.id)));
}

// ---------- 后台任务与定时维护 ----------

export async function runRefund(orderId: string): Promise<void> {
  const db = await getDb();
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order || order.status === "refunded") return;
  if (!order.providerPaymentId) throw new Error(`order ${orderId} has no payment id to refund`);
  if (order.status !== "refund_pending") {
    await db.update(orders).set({ status: "refund_pending", updatedAt: new Date() }).where(eq(orders.id, orderId));
  }
  const provider = getPaymentProvider();
  const { status } = await provider.refund({ paymentId: order.providerPaymentId, idempotencyKey: `refund:${orderId}` });
  if (status === "failed") throw new Error(`refund failed for order ${orderId}`);
  // 支付平台已确认的整单退款立即记账；之后到达的退款回调是幂等的
  if (status === "succeeded") await markRefunded(order.providerPaymentId, order.amountMinor);
  // fake 支付立即产生退款回调；Stripe 的回调稍后经 webhook 到达
  if (provider.name === "fake") {
    for (const ev of fakeRefundEvents.splice(0)) {
      await handlePaymentEvent(provider.parseWebhook(ev.body, new Headers({ "x-fake-signature": ev.signature })));
    }
  }
}

/** 运营核实投诉后发起退款：走现有的退款任务 */
export async function requestRefundByOps(orderId: string, reason: string): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update").limit(1);
    if (!order) throw new HttpError(404, "not_found");
    if (!order.providerPaymentId || order.status === "refunded" || order.status === "pending_payment" || order.status === "expired") {
      throw new HttpError(409, "not_refundable", "这笔订单当前不能退款");
    }
    await tx.update(orders).set({ status: "refund_pending", failureReason: reason, updatedAt: new Date() }).where(eq(orders.id, orderId));
    await enqueue(tx, "refund_order", { orderId, reason }, { dedupeKey: `refund:${orderId}` });
  });
}

/** 超过承诺期限仍未交付的订单启动原路退款（PRD §8，首测 24 小时） */
export async function refundOverdueOrders(): Promise<number> {
  const db = await getDb();
  const due = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(inArray(orders.status, ["paid", "generating", "generation_failed"]), lt(orders.refundDueAt, new Date())));
  for (const { id } of due) {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(orders)
        .set({ status: "refund_pending", failureReason: sql`coalesce(${orders.failureReason}, 'not_delivered_in_time')`, updatedAt: new Date() })
        .where(and(eq(orders.id, id), inArray(orders.status, ["paid", "generating", "generation_failed"])))
        .returning({ id: orders.id });
      if (updated.length) await enqueue(tx, "refund_order", { orderId: id, reason: "not_delivered_in_time" }, { dedupeKey: `refund:${id}` });
    });
  }
  return due.length;
}

/** 补收漏掉的支付回调 */
export async function reconcilePendingOrders(): Promise<void> {
  const db = await getDb();
  const pending = await db
    .select({ sessionId: orders.providerSessionId })
    .from(orders)
    .where(
      and(
        eq(orders.status, "pending_payment"),
        isNotNull(orders.providerSessionId),
        lt(orders.createdAt, new Date(Date.now() - 5 * 60_000)),
        gt(orders.createdAt, new Date(Date.now() - 2 * 24 * 3600_000)),
      ),
    )
    .limit(50);
  const provider = getPaymentProvider();
  for (const { sessionId } of pending) {
    const state = await provider.retrieveCheckout(sessionId!);
    if (state.paid) await markPaid(state);
    else if (state.status === "expired") await expireCheckout(sessionId!);
  }
}

/**
 * 已付款但没有排队或运行中生成任务的订单（例如 worker 在入队后崩溃、任务被标为失败），
 * 重新入队。配合任务租约，重启 worker 后已付款订单能继续处理。
 */
export async function recoverPaidOrders(): Promise<number> {
  const db = await getDb();
  const stuck = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.status, "paid"),
        lt(orders.paidAt, new Date(Date.now() - 60_000)),
        sql`not exists (select 1 from ${jobs} j where j.kind = 'generate_report' and j.payload->>'orderId' = ${orders.id}::text and j.status in ('queued','running'))`,
      ),
    );
  const bucket = Math.floor(Date.now() / (10 * 60_000));
  for (const { id } of stuck) {
    await enqueue(db, "generate_report", { orderId: id }, { dedupeKey: `report:${id}:recover:${bucket}` });
  }
  return stuck.length;
}

/**
 * 兼容旧订单（迁移 0001 之前创建、没有题意快照）：
 * 阅读数据在下单后没有改过 → 按当时内容补建快照；否则无法准确还原题意 →
 * 待支付的订单作废（用户可以重新解锁），已付款的转运营核实。已交付的旧报告照常可读。
 */
export async function backfillLegacyOrders(): Promise<{ rebuilt: number; expired: number; review: number }> {
  const db = await getDb();
  const legacy = await db
    .select({ order: orders, reading: readings })
    .from(orders)
    .innerJoin(readings, eq(readings.id, orders.readingId))
    .where(and(isNull(orders.basis), inArray(orders.status, ["pending_payment", "paid", "generating", "generation_failed"])))
    .limit(200);
  const result = { rebuilt: 0, expired: 0, review: 0 };
  for (const { order, reading } of legacy) {
    const recoverable = reading.questionCt !== null && reading.updatedAt.getTime() <= order.createdAt.getTime();
    if (recoverable) {
      const plain = toPlain(reading);
      const [t] = await db
        .select()
        .from(triageResults)
        .where(eq(triageResults.readingId, reading.id))
        .orderBy(desc(triageResults.createdAt))
        .limit(1);
      const out = t?.outputCt ? decryptJson<TriageOutput>(t.outputCt) : null;
      const snapshot = buildSnapshot(
        plain,
        {
          id: t?.id ?? null,
          version: t?.triageVersion ?? "legacy",
          output: out ?? { question_summary: "", missing_info: [], controllable_reframe: null, decision: "proceed", risk_category: "none" },
        },
        { includeUnreviewed: !getOffer().reviewRequired, legacy: true },
      );
      await db.update(orders).set({ ...snapshotColumns(snapshot), updatedAt: new Date() }).where(and(eq(orders.id, order.id), isNull(orders.basis)));
      result.rebuilt++;
    } else if (order.status === "pending_payment") {
      await db
        .update(orders)
        .set({ status: "expired", reviewReason: "legacy_intent_unrecoverable", updatedAt: new Date() })
        .where(and(eq(orders.id, order.id), eq(orders.status, "pending_payment")));
      result.expired++;
    } else {
      await db
        .update(orders)
        .set({ status: "needs_review", reviewReason: "legacy_intent_unrecoverable", updatedAt: new Date() })
        .where(and(eq(orders.id, order.id), notInArray(orders.status, ["delivered", "refunded", "disputed"])));
      result.review++;
    }
  }
  return result;
}
