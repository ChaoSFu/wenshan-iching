import { requireCapability } from "./capabilities";
import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { getDb, type DB } from "./db/client";
import { orders, refunds, type RefundStatus } from "./db/schema";
import { HttpError } from "./http";
import { enqueue } from "./jobs/queue";
import { recordOpsAction } from "./ops";
import { fakeRefundEvents } from "./payments/fake";
import { getPaymentProvider, type PaymentEvent, type ProviderRefund } from "./payments";

/**
 * 退款（技术方案 5.9 与附录 E）：
 * - 每次退款是一条 refunds 记录（attempt_no）。任务的自动重试复用同一条记录与同一个支付方幂等键，
 *   支付方不会重复退款。
 * - 支付方确认失败后，订单转 refund_failed 进入运营异常列表；运营核实上一笔确实失败，
 *   才开新尝试（attempt_no + 1，新幂等键）。任务去重键按尝试区分，不会被旧的失败任务挡住。
 * - 部分与整单以支付方确认的累计退款金额为准。
 */

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
type Executor = DB | Tx;

const OPEN: RefundStatus[] = ["requested", "pending"];

function keyFor(orderId: string, attemptNo: number): string {
  // 第一次尝试沿用旧版本的幂等键，迁移前已发起的退款在支付方那边会被识别为同一笔
  return attemptNo === 1 ? `refund:${orderId}` : `refund:${orderId}:${attemptNo}`;
}

async function latestAttempt(tx: Executor, orderId: string) {
  const [r] = await tx.select().from(refunds).where(eq(refunds.orderId, orderId)).orderBy(desc(refunds.attemptNo)).limit(1);
  return r ?? null;
}

/**
 * 为订单发起退款尝试（在调用方事务里）。已有进行中的尝试时复用；
 * 上一次已确认失败时，只有 allowAfterFailure（运营核实后）才开新尝试。
 */
export async function requestRefund(
  tx: Tx,
  orderId: string,
  opts: { reason: string; requestedBy: string; allowAfterFailure?: boolean },
): Promise<{ refundId: string; created: boolean } | null> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update").limit(1);
  if (!order) throw new HttpError(404, "not_found");
  if (order.status === "refunded") return null;
  const last = await latestAttempt(tx, orderId);
  if (last && OPEN.includes(last.status)) return { refundId: last.id, created: false };
  if (last && (last.status === "failed" || last.status === "canceled") && !opts.allowAfterFailure) return null;

  const attemptNo = (last?.attemptNo ?? 0) + 1;
  const [row] = await tx
    .insert(refunds)
    .values({ orderId, attemptNo, idempotencyKey: keyFor(orderId, attemptNo), reason: opts.reason, requestedBy: opts.requestedBy })
    .returning({ id: refunds.id });
  await tx
    .update(orders)
    .set({ status: "refund_pending", failureReason: sql`coalesce(${orders.failureReason}, ${opts.reason})`, updatedAt: new Date() })
    .where(eq(orders.id, orderId));
  await enqueue(tx, "refund_order", { orderId, refundId: row!.id, reason: opts.reason }, { dedupeKey: `refund:${row!.id}` });
  return { refundId: row!.id, created: true };
}

function localStatus(s: ProviderRefund["status"]): RefundStatus {
  if (s === "succeeded" || s === "failed" || s === "canceled") return s;
  return "pending";
}

/** 订单累计已退金额（支付方确认）达到订单金额：整单退款，撤回内容 */
async function settleOrder(orderId: string, cumulativeMinor: number | null): Promise<void> {
  const { revokeOrderContent, releaseReadingIfUnused } = await import("./orders");
  const db = await getDb();
  await db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update").limit(1);
    if (!order || order.status === "refunded") return;
    const succeeded = await tx
      .select({ amount: refunds.amountMinor })
      .from(refunds)
      .where(and(eq(refunds.orderId, orderId), eq(refunds.status, "succeeded")));
    const fromAttempts = succeeded.reduce((s, r) => s + (r.amount ?? 0), 0);
    const amount = Math.max(order.refundedAmountMinor, cumulativeMinor ?? 0, fromAttempts);
    if (amount >= order.amountMinor) {
      await tx
        .update(orders)
        .set({ status: "refunded", refundedAmountMinor: amount, refundedAt: new Date(), updatedAt: new Date() })
        .where(eq(orders.id, orderId));
      // 退款仍在进行中的尝试一并视为完成（累计金额已确认）
      await tx
        .update(refunds)
        .set({ status: "succeeded", updatedAt: new Date() })
        .where(and(eq(refunds.orderId, orderId), inArray(refunds.status, OPEN)));
      await revokeOrderContent(tx, orderId, "refunded");
      await releaseReadingIfUnused(tx, order.readingId);
    } else if (amount > order.refundedAmountMinor) {
      // 部分退款：记账，访问保留，并标记供运营核对
      await tx
        .update(orders)
        .set({
          refundedAmountMinor: amount,
          reviewReason: "partial_refund",
          // 之前因为发起整单退款而处于 refund_pending 的，回到原状态由运营决定
          updatedAt: new Date(),
        })
        .where(eq(orders.id, orderId));
    }
  });
}

/** 把支付方返回或回调里的退款状态写回本地，并推动订单状态 */
export async function applyProviderRefund(refundId: string, r: ProviderRefund): Promise<void> {
  const db = await getDb();
  const status = localStatus(r.status);
  const [row] = await db
    .update(refunds)
    .set({
      providerRefundId: r.refundId,
      status,
      amountMinor: r.amountMinor,
      currency: r.currency,
      failureReason: r.failureReason,
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    // 终态不再被晚到的回调改回去
    .where(and(eq(refunds.id, refundId), inArray(refunds.status, ["requested", "pending", status])))
    .returning();
  if (!row) return;
  if (status === "succeeded") {
    await settleOrder(row.orderId, null);
  } else if (status === "failed" || status === "canceled") {
    await db
      .update(orders)
      .set({ status: "refund_failed", reviewReason: "refund_failed", failureReason: `refund_${status}:${r.failureReason ?? "unknown"}`, updatedAt: new Date() })
      .where(and(eq(orders.id, row.orderId), eq(orders.status, "refund_pending")));
  }
}

/** 任务 refund_order：执行某一次退款尝试。重试时复用同一个幂等键 */
export async function runRefundAttempt(refundId: string): Promise<void> {
  requireCapability("payments");
  const db = await getDb();
  const [attempt] = await db.select().from(refunds).where(eq(refunds.id, refundId)).limit(1);
  if (!attempt || !OPEN.includes(attempt.status)) return;
  const [order] = await db.select().from(orders).where(eq(orders.id, attempt.orderId)).limit(1);
  if (!order) return;
  if (!order.providerPaymentId) {
    await applyProviderRefund(refundId, { refundId: "", status: "failed", amountMinor: 0, currency: order.currency, failureReason: "no_payment_id" });
    return;
  }
  const provider = getPaymentProvider();
  const result = attempt.providerRefundId
    ? await provider.retrieveRefund(attempt.providerRefundId)
    : await provider.refund({ paymentId: order.providerPaymentId, idempotencyKey: attempt.idempotencyKey });
  await applyProviderRefund(refundId, result);
  await deliverFakeEvents();
}

/** fake 支付把退款回调放在队列里，这里模拟 Stripe 的异步投递 */
export async function deliverFakeEvents(): Promise<void> {
  const provider = getPaymentProvider();
  if (provider.name !== "fake") return;
  const { handlePaymentEvent } = await import("./orders");
  for (const ev of fakeRefundEvents.splice(0)) {
    await handlePaymentEvent(provider.parseWebhook(ev.body, new Headers({ "x-fake-signature": ev.signature })));
  }
}

class RefundEventNotReady extends HttpError {
  constructor(what: string) {
    super(503, "event_not_ready", `no order matches ${what} yet`);
  }
}

/** 回调：单笔退款状态变化。找不到本地尝试时（例如在支付方后台手动退款）补建一条记录 */
export async function handleRefundUpdated(event: Extract<PaymentEvent, { type: "refund.updated" }>): Promise<string> {
  const db = await getDb();
  let [attempt] = await db.select().from(refunds).where(eq(refunds.providerRefundId, event.refundId)).limit(1);
  if (!attempt) {
    const [order] = await db.select().from(orders).where(eq(orders.providerPaymentId, event.paymentId)).limit(1);
    if (!order) throw new RefundEventNotReady(`payment ${event.paymentId}`);
    // 本地刚发起、还没拿到支付方编号的尝试：按订单最近一次进行中的尝试关联
    const open = await db
      .select()
      .from(refunds)
      .where(and(eq(refunds.orderId, order.id), inArray(refunds.status, OPEN)))
      .orderBy(desc(refunds.attemptNo))
      .limit(1);
    if (open[0] && !open[0].providerRefundId) {
      attempt = open[0];
    } else {
      const last = await latestAttempt(db, order.id);
      const attemptNo = (last?.attemptNo ?? 0) + 1;
      [attempt] = await db
        .insert(refunds)
        .values({
          orderId: order.id,
          attemptNo,
          idempotencyKey: `external:${event.refundId}`,
          providerRefundId: event.refundId,
          reason: "initiated_at_provider",
          requestedBy: "provider",
        })
        .onConflictDoNothing()
        .returning();
      if (!attempt) [attempt] = await db.select().from(refunds).where(eq(refunds.idempotencyKey, `external:${event.refundId}`)).limit(1);
    }
  }
  await applyProviderRefund(attempt!.id, {
    refundId: event.refundId,
    status: event.status,
    amountMinor: event.amountMinor,
    currency: event.currency,
    failureReason: event.failureReason,
  });
  return attempt!.orderId;
}

/** 回调：付款累计已退金额（charge.refunded）。支付方的累计数为准 */
export async function handleCumulativeRefund(paymentId: string, amountRefundedMinor: number): Promise<string> {
  const db = await getDb();
  const [order] = await db.select().from(orders).where(eq(orders.providerPaymentId, paymentId)).limit(1);
  if (!order) throw new RefundEventNotReady(`payment ${paymentId}`);
  await settleOrder(order.id, amountRefundedMinor);
  return order.id;
}

/**
 * 运营核实后重试：先向支付方核对上一次尝试的真实结果。确实失败才开新尝试；
 * 支付方显示已成功或仍在处理，就只同步状态，不重复退款。
 */
export async function retryRefundByOps(orderId: string, actor: string, note: string): Promise<string> {
  const db = await getDb();
  const last = await latestAttempt(db, orderId);
  if (!last || (last.status !== "failed" && last.status !== "canceled")) {
    await recordOpsAction({ actor, action: "retry_refund", orderId, result: "rejected:not_failed", note });
    throw new HttpError(409, "refund_not_failed", "上一次退款不是失败状态，不能重试");
  }
  if (last.providerRefundId) {
    const current = await getPaymentProvider().retrieveRefund(last.providerRefundId);
    if (current.status !== "failed" && current.status !== "canceled") {
      await applyProviderRefund(last.id, current);
      await recordOpsAction({ actor, action: "retry_refund", orderId, result: `synced:${current.status}`, note });
      return `支付方显示上一笔退款为 ${current.status}，已同步状态，未重复发起`;
    }
  }
  const created = await db.transaction((tx) => requestRefund(tx, orderId, { reason: "ops_retry", requestedBy: `ops:${actor}`, allowAfterFailure: true }));
  await recordOpsAction({ actor, action: "retry_refund", orderId, result: created?.created ? "requested" : "noop", note });
  return created?.created ? "已开新的退款尝试" : "没有需要重试的退款";
}

/**
 * 定时对账：长时间未终结的退款向支付方查询；还没拿到支付方编号的，按同一幂等键重新入队；
 * 迁移前遗留的 refund_pending 订单补建第一次尝试（沿用旧幂等键）。
 */
export async function reconcileRefunds(): Promise<number> {
  const db = await getDb();
  const stale = await db
    .select()
    .from(refunds)
    .where(and(inArray(refunds.status, OPEN), lt(refunds.updatedAt, new Date(Date.now() - 15 * 60_000))))
    .limit(100);
  const provider = getPaymentProvider();
  const bucket = Math.floor(Date.now() / (15 * 60_000));
  for (const r of stale) {
    if (r.providerRefundId) {
      await applyProviderRefund(r.id, await provider.retrieveRefund(r.providerRefundId));
    } else {
      await enqueue(db, "refund_order", { orderId: r.orderId, refundId: r.id, reason: r.reason }, { dedupeKey: `refund:${r.id}:${bucket}` });
    }
  }
  const legacy = await db
    .select({ id: orders.id, reason: orders.failureReason })
    .from(orders)
    .where(
      and(
        eq(orders.status, "refund_pending"),
        isNotNull(orders.providerPaymentId),
        sql`not exists (select 1 from ${refunds} r where r.order_id = ${orders.id})`,
      ),
    )
    .limit(100);
  for (const o of legacy) {
    await db.transaction((tx) => requestRefund(tx, o.id, { reason: o.reason ?? "legacy_refund", requestedBy: "system" }));
  }
  await deliverFakeEvents();
  return stale.length + legacy.length;
}

export async function refundAttempts(orderId: string) {
  const db = await getDb();
  return db.select().from(refunds).where(eq(refunds.orderId, orderId)).orderBy(desc(refunds.attemptNo)).limit(5);
}
