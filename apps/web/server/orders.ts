import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { getDb, type DB } from "./db/client";
import { followups, orders, paymentEvents, readings, reports, type OrderStatus } from "./db/schema";
import { env } from "./env";
import { HttpError } from "./http";
import { enqueue } from "./jobs/queue";
import { fakeRefundEvents } from "./payments/fake";
import { getPaymentProvider, type CheckoutState, type PaymentEvent } from "./payments";
import { loadOwnedReading } from "./readings";
import { requirePurchasableTriage } from "./triage";

/**
 * 订单状态机（技术方案 5.9）：
 * pending_payment → paid → generating → delivered
 *                 ↘ expired            ↘ generation_failed → refund_pending → refunded
 * delivered → refunded / disputed（撤销访问）
 */

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/** 视为"已经有一笔有效付款"的状态 */
const PAID_STATES: OrderStatus[] = ["paid", "generating", "delivered", "generation_failed"];

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
  failureReason: string | null;
  checkoutUrl: string | null;
  reportId: string | null;
  clientReadingId: string;
  followupsRemaining: number;
}

export async function createOrderForReading(
  user: { id: string; email: string },
  readingId: string,
): Promise<{ orderId: string; checkoutUrl: string | null }> {
  const reading = await loadOwnedReading(user.id, readingId);
  await requirePurchasableTriage(reading);
  const db = await getDb();
  const e = env();

  const existing = await db
    .select()
    .from(orders)
    .where(and(eq(orders.readingId, reading.id), eq(orders.userId, user.id)))
    .orderBy(desc(orders.createdAt));
  const paid = existing.find((o) => PAID_STATES.includes(o.status));
  if (paid) return { orderId: paid.id, checkoutUrl: null };
  // 复用未完成且未过期的结账，避免重复付款（PRD §4）
  const open = existing.find(
    (o) => o.status === "pending_payment" && o.checkoutUrl && o.checkoutExpiresAt && o.checkoutExpiresAt.getTime() > Date.now() + 2 * 60_000,
  );
  if (open) return { orderId: open.id, checkoutUrl: open.checkoutUrl };

  const provider = getPaymentProvider();
  const [order] = await db
    .insert(orders)
    .values({
      userId: user.id,
      readingId: reading.id,
      amountMinor: e.PRICE_AMOUNT_MINOR,
      currency: e.PRICE_CURRENCY,
      priceVersion: e.PRICE_VERSION,
      provider: provider.name,
    })
    .returning();

  const session = await provider.createCheckout({
    orderId: order!.id,
    amountMinor: order!.amountMinor,
    currency: order!.currency,
    email: user.email,
    description: "问山解读报告（含三次追问）",
    successUrl: `${e.APP_URL}/orders/${order!.id}?from=checkout`,
    cancelUrl: `${e.APP_URL}/r/${reading.clientReadingId}`,
    idempotencyKey: `checkout:${order!.id}`,
  });
  await db
    .update(orders)
    .set({
      providerSessionId: session.sessionId,
      checkoutUrl: session.url,
      checkoutExpiresAt: session.expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(orders.id, order!.id));
  return { orderId: order!.id, checkoutUrl: session.url };
}

/**
 * 收到付款：核对金额、币种后把订单置为已支付，并在同一事务里入队生成任务。
 * 条件更新保证同一笔付款只发一次货；webhook、成功页、对账任务都调用这里。
 */
export async function markPaid(state: CheckoutState): Promise<"paid" | "duplicate" | "noop" | "mismatch" | "not_paid" | "unknown"> {
  if (state.status !== "complete" || !state.paid) return "not_paid";
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.providerSessionId, state.sessionId)).for("update").limit(1);
    if (!order) return "unknown";
    if (state.amountMinor !== order.amountMinor || state.currency?.toLowerCase() !== order.currency.toLowerCase()) {
      console.error(`[orders] amount/currency mismatch for order ${order.id}`);
      await tx.update(orders).set({ failureReason: "amount_mismatch", updatedAt: new Date() }).where(eq(orders.id, order.id));
      return "mismatch";
    }
    if (order.status !== "pending_payment" && order.status !== "expired") return "noop";

    const now = new Date();
    const [other] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.readingId, order.readingId), ne(orders.id, order.id), inArray(orders.status, PAID_STATES)))
      .limit(1);
    if (other) {
      // 同一卦付了两次（例如开了两个标签页）：第二笔自动退款
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

/** 退款或拒付后撤销报告与追问的访问，并清除内容（技术方案 §2-7） */
export async function purgeOrderContent(tx: Tx, orderId: string, reason: string): Promise<void> {
  const now = new Date();
  await tx
    .update(reports)
    .set({ contentCt: null, citationsSnapshotCt: null, deletedAt: now, deleteReason: reason })
    .where(and(eq(reports.orderId, orderId), isNull(reports.deletedAt)));
  await tx.update(followups).set({ questionCt: null, answerCt: null, updatedAt: now }).where(eq(followups.orderId, orderId));
  const [o] = await tx.select({ readingId: orders.readingId }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (o) {
    await tx
      .update(readings)
      .set({ questionCt: null, contextCt: null, deletedAt: now })
      .where(eq(readings.id, o.readingId));
  }
}

async function markRefunded(paymentId: string): Promise<string | null> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.providerPaymentId, paymentId)).for("update").limit(1);
    if (!order || order.status === "refunded") return order?.id ?? null;
    await tx.update(orders).set({ status: "refunded", refundedAt: new Date(), updatedAt: new Date() }).where(eq(orders.id, order.id));
    await purgeOrderContent(tx, order.id, "refunded");
    return order.id;
  });
}

async function markDisputed(paymentId: string): Promise<string | null> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.providerPaymentId, paymentId)).for("update").limit(1);
    if (!order) return null;
    await tx.update(orders).set({ status: "disputed", updatedAt: new Date() }).where(eq(orders.id, order.id));
    await purgeOrderContent(tx, order.id, "disputed");
    return order.id;
  });
}

/**
 * 处理一条支付回调（已验签）。事件 id 去重防重放；处理逻辑本身也是幂等的，
 * 所以处理到一半失败、支付平台重发时可以安全地重做。
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
      orderId = await markRefunded(event.paymentId);
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
    failureReason: o.failureReason,
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
  await provider.refund({ paymentId: order.providerPaymentId, idempotencyKey: `refund:${orderId}` });
  // fake 支付立即产生退款回调；Stripe 的回调稍后经 webhook 到达
  if (provider.name === "fake") {
    for (const ev of fakeRefundEvents.splice(0)) {
      await handlePaymentEvent(provider.parseWebhook(ev.body, new Headers({ "x-fake-signature": ev.signature })));
    }
  }
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
