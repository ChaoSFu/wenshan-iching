import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { decryptJson, sha256 } from "./crypto";
import { getDb, type DB } from "./db/client";
import { checkoutAttempts, followups, jobs, orders, paymentEvents, readings, reports, supportTickets, triageResults, type OrderStatus } from "./db/schema";
import { env } from "./env";
import { HttpError } from "./http";
import { enqueue } from "./jobs/queue";
import { assertContentApproved, assertSalesOpen, getOffer } from "./offer";
import { recordOpsAction } from "./ops";
import { ensureCheckout, expireAttemptBySession, openCheckoutUrl, reconcileCheckouts, syncOrderCheckouts } from "./checkout";
import { getPaymentProvider, type CheckoutState, type PaymentEvent } from "./payments";
import { loadOwnedReading, toPlain } from "./readings";
import { handleCumulativeRefund, handleRefundUpdated, requestRefund } from "./refunds";
import { buildSnapshot, snapshotColumns } from "./snapshot";
import { TRIAGE_VERSION, requirePurchasableTriage, type TriageOutput } from "./triage";

/**
 * 订单状态机（技术方案 5.9、附录 D、E）：
 * pending_payment → paid → generating → delivered
 *                 ↘ expired            ↘ generation_failed → refund_pending → refunded
 *                                                              ↘ refund_failed（运营核实后重试）
 * paid 但金额/币种异常、旧订单无法还原题意等 → needs_review
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
  /** 支付方确认的实际收款（旧单未核实时为空） */
  paidAmountMinor: number | null;
  paidCurrency: string | null;
  /** 支付方确认的已成功退款合计 */
  refundedAmountMinor: number;
  refundedCurrency: string | null;
  failureReason: string | null;
  reviewReason: string | null;
  checkoutUrl: string | null;
  reportId: string | null;
  clientReadingId: string;
  followupsRemaining: number;
}

/** 解锁页提交的确认：用户看到并确认的题意修订、分流结果与报价 */
export const createOrderSchema = z.object({
  readingId: z.uuid(),
  readingRevision: z.number().int().positive(),
  triageId: z.uuid(),
  priceVersion: z.string().min(1).max(60),
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

/**
 * 创建（或复用）一次付款尝试。
 * 1. 校验用户确认时看到的题意修订、分流结果、报价仍是当前的；变了就返回 409，页面重新确认。
 * 2. 同一确认（修订 + 分流 + 报价）只对应一个待支付订单：先持久化订单与确认标识，再调用支付方；
 *    并发点击、网络重试命中同一个订单，支付方幂等键 checkout:<订单号> 保证只有一个 Checkout。
 */
export async function createOrderForReading(
  user: { id: string; email: string },
  input: CreateOrderInput,
): Promise<{ orderId: string; checkoutUrl: string | null }> {
  const offer = assertSalesOpen();
  const reading = await loadOwnedReading(user.id, input.readingId);
  const db = await getDb();

  // 同一卦已有有效付款：直接回到那笔订单（编辑问题不会产生第二份报告）
  const [paid] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.readingId, reading.id), eq(orders.userId, user.id), inArray(orders.status, [...PAID_STATES, "needs_review"])))
    .limit(1);
  if (paid) return { orderId: paid.id, checkoutUrl: null };

  const triage = await requirePurchasableTriage(reading);
  if (input.readingRevision !== reading.revision || input.triageId !== triage.id) {
    throw new HttpError(409, "intent_changed", "题意在别处更新过，请重新确认", { revision: reading.revision, triageId: triage.id });
  }
  if (input.priceVersion !== offer.priceVersion) {
    throw new HttpError(409, "price_changed", `价格已更新为 ${offer.priceLabel}，请重新确认`, {
      priceVersion: offer.priceVersion,
      priceLabel: offer.priceLabel,
    });
  }
  assertContentApproved(reading.cast, reading.topicId);

  const confirmationKey = sha256(
    [reading.id, reading.revision, triage.id, offer.priceVersion, offer.amountMinor, offer.currency].join("|"),
  );

  // 同一确认只有一个待支付订单；它的付款尝试（会话过期、响应丢失后的新尝试）都挂在这笔订单下
  let order = await pendingFor(confirmationKey);
  if (!order) {
    const snapshot = buildSnapshot(reading, { id: triage.id, version: TRIAGE_VERSION, output: triage.output }, { includeUnreviewed: !offer.reviewRequired });
    if (snapshot.missing.length) throw new HttpError(409, "content_pending", "这一卦有原文仍在补录，暂时不能购买");
    const [inserted] = await db
      .insert(orders)
      .values({
        userId: user.id,
        readingId: reading.id,
        amountMinor: offer.amountMinor,
        currency: offer.currency,
        priceVersion: offer.priceVersion,
        provider: getPaymentProvider().name,
        confirmationKey,
        ...snapshotColumns(snapshot),
      })
      .onConflictDoNothing()
      .returning();
    // 并发请求已经插入同一确认的订单：复用它
    order = inserted ?? (await pendingFor(confirmationKey));
    if (!order) throw new HttpError(409, "order_conflict", "请刷新后重试");
  }
  // 返回 null：旧会话在关闭前被付款，订单已转为已支付，直接去订单页
  return { orderId: order.id, checkoutUrl: await ensureCheckout(order, user.email, reading.clientReadingId) };
}

async function pendingFor(confirmationKey: string) {
  const db = await getDb();
  const [o] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.confirmationKey, confirmationKey), eq(orders.status, "pending_payment")))
    .limit(1);
  return o ?? null;
}

class PaymentEventNotReady extends HttpError {
  constructor(what: string) {
    // 503：支付平台会稍后重发；对账任务也会补查
    super(503, "event_not_ready", `no order matches ${what} yet`);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 收到付款：以支付方数据为准，分开记下实际收款的金额与币种（与报价分开存），
 * 核对一致后把订单置为已支付，并在同一事务里入队生成任务。
 * 先按会话 ID 找付款尝试；会话 ID 还没写回时按支付方元数据里的尝试 ID（迁移前的会话按订单号）关联。
 * 条件更新保证同一笔付款只发一次货；webhook、成功页、对账任务都调用这里。
 * 找不到对应订单时抛出 503，支付平台会重发（不把事件标记为已处理）。
 */
export async function markPaid(
  state: CheckoutState,
): Promise<"paid" | "duplicate" | "noop" | "needs_review" | "refund_after_delete" | "not_paid"> {
  if (state.status !== "complete" || !state.paid) return "not_paid";
  const db = await getDb();
  return db.transaction(async (tx) => {
    let [att] = await tx.select().from(checkoutAttempts).where(eq(checkoutAttempts.providerSessionId, state.sessionId)).limit(1);
    if (!att && state.attemptId && UUID.test(state.attemptId)) {
      [att] = await tx.select().from(checkoutAttempts).where(eq(checkoutAttempts.id, state.attemptId)).limit(1);
      if (att?.providerSessionId && att.providerSessionId !== state.sessionId) att = undefined;
    }
    let orderId = att?.orderId ?? null;
    if (!orderId) {
      // 迁移前的会话：订单上记的会话 ID，或支付方元数据里的订单号（写回前进程中断）
      const [bySession] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.providerSessionId, state.sessionId)).limit(1);
      orderId = bySession?.id ?? (state.orderId && UUID.test(state.orderId) ? state.orderId : null);
    }
    const [order] = orderId ? await tx.select().from(orders).where(eq(orders.id, orderId)).for("update").limit(1) : [];
    if (!order) throw new PaymentEventNotReady(`checkout ${state.sessionId}`);

    if (att) {
      await tx
        .update(checkoutAttempts)
        .set({ status: "complete", providerSessionId: state.sessionId, providerPaymentId: state.paymentId, updatedAt: new Date() })
        .where(eq(checkoutAttempts.id, att.id));
    } else {
      // 迁移前、没有尝试记录的会话：补一条 legacy 尝试，之后按会话 ID 就能找到
      const [m] = await tx.select({ n: sql<number>`coalesce(max(${checkoutAttempts.attemptNo}), 0)::int` }).from(checkoutAttempts).where(eq(checkoutAttempts.orderId, order.id));
      await tx
        .insert(checkoutAttempts)
        .values({
          id: crypto.randomUUID(),
          orderId: order.id,
          attemptNo: (m?.n ?? 0) + 1,
          idempotencyKey: `legacy-session:${state.sessionId}`,
          amountMinor: order.amountMinor,
          currency: order.currency,
          successUrl: "",
          cancelUrl: "",
          description: "",
          requestedExpiresAt: state.expiresAt ?? new Date(),
          status: "complete",
          providerSessionId: state.sessionId,
          providerPaymentId: state.paymentId,
          legacy: true,
        })
        .onConflictDoNothing();
    }

    if (order.status !== "pending_payment" && order.status !== "expired") {
      if (state.paymentId && order.providerPaymentId && state.paymentId !== order.providerPaymentId) {
        // 同一订单的另一笔付款（开新尝试前已确认旧会话不可支付，理论上不会发生）：这笔单独原路退款，订单本身不受影响
        console.error(`[orders] second payment ${state.paymentId} for order ${order.id}; refunding it`);
        await requestRefund(tx, order.id, { reason: "extra_payment_same_order", requestedBy: "system", paymentId: state.paymentId });
        return "duplicate";
      }
      return "noop";
    }
    const paidFields = {
      paidAt: sql`now()`,
      providerPaymentId: state.paymentId,
      paidAmountMinor: state.amountMinor,
      paidCurrency: state.currency?.toLowerCase() ?? null,
      providerSessionId: state.sessionId,
      updatedAt: new Date(),
    };

    if (state.amountMinor !== order.amountMinor || state.currency?.toLowerCase() !== order.currency.toLowerCase()) {
      console.error(`[orders] amount/currency mismatch for order ${order.id}`);
      await tx.update(orders).set({ status: "needs_review", reviewReason: "amount_mismatch", ...paidFields }).where(eq(orders.id, order.id));
      return "needs_review";
    }
    // 用户在付款前删除了这一卦：不能交付，原路退款
    if (order.contentPurgedAt) {
      await tx.update(orders).set({ status: "refund_pending", ...paidFields }).where(eq(orders.id, order.id));
      await requestRefund(tx, order.id, { reason: "paid_after_delete", requestedBy: "system" });
      return "refund_after_delete";
    }
    if (!order.basis || !order.intentCt) {
      await tx.update(orders).set({ status: "needs_review", reviewReason: "legacy_intent_unrecoverable", ...paidFields }).where(eq(orders.id, order.id));
      return "needs_review";
    }

    const [other] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.readingId, order.readingId), ne(orders.id, order.id), inArray(orders.status, PAID_STATES)))
      .limit(1);
    if (other) {
      // 同一卦付了两次（例如开了两个标签页）：第二笔自动退款，原订单不受影响
      await tx.update(orders).set({ status: "refund_pending", failureReason: "duplicate_payment", ...paidFields }).where(eq(orders.id, order.id));
      await requestRefund(tx, order.id, { reason: "duplicate_payment", requestedBy: "system" });
      return "duplicate";
    }

    // 交付期限用数据库时间：交付与超时退款按同一个时钟判断（见 deliver 与 refundOverdueOrders）
    await tx
      .update(orders)
      .set({ status: "paid", refundDueAt: sql`now() + make_interval(hours => ${env().REFUND_AFTER_HOURS})`, ...paidFields })
      .where(eq(orders.id, order.id));
    await enqueue(tx, "generate_report", { orderId: order.id }, { dedupeKey: `report:${order.id}` });
    return "paid";
  });
}

/** 任务 expire_checkout：见 checkout.ts（订单删除或作废后关闭它所有未终结的会话） */
export { expireCheckoutForOrder } from "./checkout";

/**
 * 按订单撤回：清除这笔订单的报告、追问、题意快照里的个人内容，
 * 以及工单里随附的这笔订单或报告的问卦原文。账务字段保留。
 * 同一卦的其他订单不受影响（重复付款退款不能波及原订单）。
 */
export async function revokeOrderContent(tx: Tx, orderId: string, reason: string): Promise<void> {
  const now = new Date();
  const revokedReports = await tx
    .update(reports)
    .set({ contentCt: null, citationsSnapshotCt: null, deletedAt: now, deleteReason: reason })
    .where(and(eq(reports.orderId, orderId), isNull(reports.deletedAt)))
    .returning({ id: reports.id });
  // 进行中的追问作废：晚到的生成结果不会再写回答，也不会再改动次数
  await tx
    .update(followups)
    .set({ status: "canceled", questionCt: null, answerCt: null, updatedAt: now })
    .where(and(eq(followups.orderId, orderId), eq(followups.status, "queued")));
  await tx.update(followups).set({ questionCt: null, answerCt: null, updatedAt: now }).where(eq(followups.orderId, orderId));
  await tx.update(orders).set({ intentCt: null, contentPurgedAt: now, updatedAt: now }).where(eq(orders.id, orderId));
  const reportIds = revokedReports.map((r) => r.id);
  await tx
    .update(supportTickets)
    .set({ questionCt: null, updatedAt: now })
    .where(reportIds.length ? or(eq(supportTickets.orderId, orderId), inArray(supportTickets.reportId, reportIds)) : eq(supportTickets.orderId, orderId));
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
      await expireAttemptBySession(event.sessionId);
      break;
    case "refund.succeeded":
      orderId = await handleCumulativeRefund(event.paymentId, event.amountRefundedMinor);
      break;
    case "refund.updated":
      orderId = await handleRefundUpdated(event);
      note = event.status;
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
  const checkoutUrl = o.status === "pending_payment" ? await openCheckoutUrl(o.id) : null;
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
    paidAmountMinor: o.paidAmountMinor,
    paidCurrency: o.paidCurrency,
    refundedAmountMinor: o.refundedAmountMinor,
    refundedCurrency: o.refundedCurrency,
    failureReason: o.failureReason,
    reviewReason: o.reviewReason,
    checkoutUrl,
    reportId: o.status === "delivered" && row.reportId && !row.reportDeleted ? row.reportId : null,
    clientReadingId: row.clientReadingId,
    followupsRemaining: Math.max(0, o.followupsTotal - o.followupsUsed),
  };
}

/** 支付成功页主动核对一次（Stripe 推荐 webhook 与落地页双路履约） */
export async function confirmOrder(userId: string, orderId: string): Promise<OrderView> {
  const view = await getOrderView(userId, orderId);
  if (view.status === "pending_payment" || view.status === "expired") {
    await syncOrderCheckouts(orderId);
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

// ---------- 运营与后台任务 ----------

/** 运营核实投诉后发起退款：走现有的退款流程，并记录操作人 */
export async function requestRefundByOps(orderId: string, reason: string, actor = "ops"): Promise<void> {
  const db = await getDb();
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new HttpError(404, "not_found");
  if (!order.providerPaymentId || ["refunded", "pending_payment", "expired"].includes(order.status)) {
    await recordOpsAction({ actor, action: "refund", orderId, result: "rejected:not_refundable", note: reason });
    throw new HttpError(409, "not_refundable", "这笔订单当前不能退款");
  }
  const r = await db.transaction((tx) => requestRefund(tx, orderId, { reason, requestedBy: `ops:${actor}` }));
  await recordOpsAction({ actor, action: "refund", orderId, result: r ? (r.created ? "requested" : "already_open") : "blocked:previous_failed", note: reason });
  if (!r) throw new HttpError(409, "refund_failed_before", "上一次退款已失败，请用“核实后重试”");
}

/** 运营：生成异常或待核实（已有题意快照）的订单重新生成 */
export async function requeueGenerationByOps(orderId: string, actor: string, note: string): Promise<void> {
  const db = await getDb();
  const updated = await db
    .update(orders)
    // 运营接手后重新承诺交付期限（否则过期的期限会让生成直接跳过、转退款）
    .set({ status: "paid", reviewReason: null, refundDueAt: sql`greatest(${orders.refundDueAt}, now() + make_interval(hours => ${env().REFUND_AFTER_HOURS}))`, updatedAt: new Date() })
    .where(
      and(
        eq(orders.id, orderId),
        inArray(orders.status, ["generation_failed", "needs_review"]),
        isNotNull(orders.basis),
        isNotNull(orders.intentCt),
        sql`coalesce(${orders.reviewReason}, '') <> 'amount_mismatch'`,
        // 以数据为准，不只看原因文字：支付方确认的实收必须与报价一致（实收未核实的旧单不能直接重新生成）
        sql`${orders.paidAmountMinor} = ${orders.amountMinor} and lower(${orders.paidCurrency}) = lower(${orders.currency})`,
        lt(orders.generationCalls, env().MAX_REPORT_CALLS_PER_ORDER),
      ),
    )
    .returning({ id: orders.id });
  await recordOpsAction({ actor, action: "requeue_generation", orderId, result: updated.length ? "requeued" : "rejected", note });
  if (!updated.length) throw new HttpError(409, "not_requeueable", "这笔订单不能重新生成（金额异常、缺少题意快照或已达调用上限）");
  await enqueue(db, "generate_report", { orderId }, { dedupeKey: `report:${orderId}:ops:${Date.now()}` });
}

/** 尚未交付、交付期限一过就转退款的状态 */
export const UNDELIVERED: OrderStatus[] = ["paid", "generating", "generation_failed"];

/**
 * 超过承诺期限仍未交付的订单启动原路退款（PRD §8，首测 24 小时）。约定（附录 F.3）：
 * - 交付事务在数据库时间 ≤ refund_due_at 时提交 → 已交付，不退款；
 * - 过了期限仍未交付 → 原路退款；之后完成的报告丢弃（交付事务自己也会发起这笔退款）。
 * 两边都在订单行锁下、按数据库时间重新校验，竞争时只会得到其中一个结果。
 */
export async function refundOverdueOrders(): Promise<number> {
  const db = await getDb();
  const due = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(inArray(orders.status, UNDELIVERED), sql`${orders.refundDueAt} < now()`));
  let n = 0;
  for (const { id } of due) {
    const r = await db.transaction(async (tx) => {
      // 取得订单锁后重新校验：等锁期间报告可能已经交付
      const [o] = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.id, id), inArray(orders.status, UNDELIVERED), sql`${orders.refundDueAt} < now()`))
        .for("update")
        .limit(1);
      if (!o) return null;
      return requestRefund(tx, id, { reason: "not_delivered_in_time", requestedBy: "system", fromStatuses: UNDELIVERED });
    });
    if (r) n++;
  }
  return n;
}

/** 补收漏掉的支付回调（包括 Checkout 已建立、会话编号还没写回的付款尝试） */
export async function reconcilePendingOrders(): Promise<void> {
  await reconcileCheckouts();
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
 * 阅读数据在下单（已交付的：交付）后没有改过 → 按当时内容补建快照；否则无法准确还原题意 →
 * 待支付的订单作废（用户可以重新解锁），已付款未交付的转运营核实；已交付的旧报告照常可读，
 * 只是不能继续追问。
 */
export async function backfillLegacyOrders(): Promise<{ rebuilt: number; expired: number; review: number }> {
  const db = await getDb();
  const legacy = await db
    .select({ order: orders, reading: readings })
    .from(orders)
    .innerJoin(readings, eq(readings.id, orders.readingId))
    .where(
      and(
        isNull(orders.basis),
        isNull(orders.contentPurgedAt),
        inArray(orders.status, ["pending_payment", "paid", "generating", "generation_failed", "delivered"]),
        // 已标记为"旧报告不能追问"的不再重复处理
        sql`coalesce(${orders.reviewReason}, '') <> 'legacy_followups_unavailable'`,
      ),
    )
    .limit(200);
  const result = { rebuilt: 0, expired: 0, review: 0 };
  for (const { order, reading } of legacy) {
    const asOf = order.status === "delivered" && order.deliveredAt ? order.deliveredAt : order.createdAt;
    const recoverable = reading.questionCt !== null && reading.updatedAt.getTime() <= asOf.getTime();
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
    } else if (order.status !== "delivered") {
      await db
        .update(orders)
        .set({ status: "needs_review", reviewReason: "legacy_intent_unrecoverable", updatedAt: new Date() })
        .where(and(eq(orders.id, order.id), notInArray(orders.status, ["delivered", "refunded", "disputed"])));
      result.review++;
    } else {
      // 已交付但阅读改过：报告可读，不能追问；只标记一次，避免每轮重复处理
      await db
        .update(orders)
        .set({ reviewReason: "legacy_followups_unavailable", updatedAt: new Date() })
        .where(and(eq(orders.id, order.id), isNull(orders.reviewReason)));
    }
  }
  return result;
}
