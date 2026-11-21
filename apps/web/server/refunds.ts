import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { requireCapability } from "./capabilities";
import { getDb, type DB } from "./db/client";
import { checkoutAttempts, orders, refunds, type OrderStatus, type RefundStatus } from "./db/schema";
import { HttpError } from "./http";
import { enqueue } from "./jobs/queue";
import { recordOpsAction } from "./ops";
import { fakeRefundEvents } from "./payments/fake";
import { RefundRejectedError, getPaymentProvider, type PaymentEvent, type ProviderRefund } from "./payments";

/**
 * 退款流水（技术方案 5.9、附录 E、F.2）：
 * - 每笔退款是一条 refunds 记录：本系统发起的尝试（source=local），或在支付方后台发起、独立入账的外部退款。
 *   支付方退款 ID 全表唯一，按 ID（其次按退款元数据里的记录 ID）绑定，不再按"最近一次尝试"猜。
 * - 订单分开记报价（amount）、支付方确认的实收（paid_amount）与已成功退款（refunded_amount），
 *   整单退款以同一笔实收为比较基准；结算只看流水，每次变化都在订单行锁下重算。
 * - 普通回调只能推进未终结的记录（乱序保护）；与本地终态矛盾的回调触发一次主动核实。
 *   主动向支付方查询的结果可以更正本地误判，但必须是同一笔付款、同一个退款 ID。
 * - 本地尝试的自动重试复用同一条记录与同一个幂等键；结果持续未知达到上限后转人工核实。
 */

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
type Executor = DB | Tx;
type RefundRow = typeof refunds.$inferSelect;

const OPEN: RefundStatus[] = ["requested", "pending"];
const TERMINAL: RefundStatus[] = ["succeeded", "failed", "canceled"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 没拿到支付方退款 ID 的尝试最多自动重试几次 */
export const MAX_REFUND_TRIES = 6;
/** Stripe 幂等键 24 小时后失效；之前转人工，避免旧键失效后自动重发 */
const UNCONFIRMED_AFTER_MS = 20 * 3600_000;

class RefundEventNotReady extends HttpError {
  constructor(what: string) {
    super(503, "event_not_ready", `no order matches ${what} yet`);
  }
}

function localStatus(s: ProviderRefund["status"]): RefundStatus {
  if (s === "succeeded" || s === "failed" || s === "canceled") return s;
  return "pending";
}

/** 订单的主付款（第二笔意外付款的退款单独记，不计入订单的退款合计） */
function forMainPayment(order: { providerPaymentId: string | null }) {
  return (r: Pick<RefundRow, "providerPaymentId">) => !r.providerPaymentId || !order.providerPaymentId || r.providerPaymentId === order.providerPaymentId;
}

async function latestLocalAttempt(tx: Executor, orderId: string, paymentId: string | null): Promise<RefundRow | null> {
  const [r] = await tx
    .select()
    .from(refunds)
    .where(
      and(
        eq(refunds.orderId, orderId),
        eq(refunds.source, "local"),
        paymentId ? or(eq(refunds.providerPaymentId, paymentId), isNull(refunds.providerPaymentId)) : undefined,
      ),
    )
    .orderBy(desc(refunds.attemptNo))
    .limit(1);
  return r ?? null;
}

async function nextAttemptNo(tx: Executor, orderId: string): Promise<number> {
  const [m] = await tx.select({ n: sql<number>`coalesce(max(${refunds.attemptNo}), 0)::int` }).from(refunds).where(eq(refunds.orderId, orderId));
  return (m?.n ?? 0) + 1;
}

/**
 * 为订单发起退款尝试（在调用方事务里，先锁订单）。已有进行中的尝试时复用；
 * 上一次已确认失败时，只有 allowAfterFailure（运营核实后）才开新尝试。
 * - fromStatuses：只有订单仍处于这些状态时才发起（超时退款取得锁后重新校验）；
 * - paymentId：退另一笔付款（同一订单的意外第二笔付款），订单状态不变；
 * - legacyKey：迁移前遗留的退款，沿用当时的幂等键与请求参数。
 */
export async function requestRefund(
  tx: Tx,
  orderId: string,
  opts: { reason: string; requestedBy: string; allowAfterFailure?: boolean; fromStatuses?: OrderStatus[]; paymentId?: string; legacyKey?: boolean },
): Promise<{ refundId: string; created: boolean } | null> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update").limit(1);
  if (!order) throw new HttpError(404, "not_found");
  const paymentId = opts.paymentId ?? order.providerPaymentId;
  const extra = Boolean(opts.paymentId && opts.paymentId !== order.providerPaymentId);
  if (!extra && order.status === "refunded") return null;
  if (opts.fromStatuses && !opts.fromStatuses.includes(order.status)) return null;

  const last = await latestLocalAttempt(tx, orderId, paymentId);
  if (last && OPEN.includes(last.status)) return last.escalatedAt ? null : { refundId: last.id, created: false };
  if (last && (last.status === "failed" || last.status === "canceled") && !opts.allowAfterFailure) return null;

  const id = randomUUID();
  await tx.insert(refunds).values({
    id,
    orderId,
    attemptNo: await nextAttemptNo(tx, orderId),
    idempotencyKey: opts.legacyKey ? `refund:${orderId}` : `refund:${orderId}:${id}`,
    legacyRequest: Boolean(opts.legacyKey),
    providerPaymentId: paymentId,
    reason: opts.reason,
    requestedBy: opts.requestedBy,
  });
  if (!extra) {
    await tx
      .update(orders)
      .set({ status: "refund_pending", failureReason: sql`coalesce(${orders.failureReason}, ${opts.reason})`, updatedAt: new Date() })
      .where(eq(orders.id, orderId));
  }
  await enqueue(tx, "refund_order", { orderId, refundId: id, reason: opts.reason }, { dedupeKey: `refund:${id}` });
  return { refundId: id, created: true };
}

/**
 * 按退款流水重算订单的退款结果（在订单行锁下）。返回重算后的订单状态。
 * - 合计 ≥ 实收：整单退款，按订单撤回内容；
 * - 0 < 合计 < 实收：部分退款，访问保留，进运营列表；
 * - 原先判定为已退款、后来退款失败（例如支付方先成功后失败）：转 refund_failed，等运营核实；
 * - 进行中的退款全部结束且最近一次失败：refund_failed；运营核实发现支付方仍在处理：回到 refund_pending。
 * 迁移前实收无法核实的旧单只记账，转运营核实。
 */
export async function recomputeOrderRefunds(tx: Tx, orderId: string): Promise<OrderStatus | null> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update").limit(1);
  if (!order) return null;
  if (!order.providerPaymentId) return order.status;
  const rows = (await tx.select().from(refunds).where(eq(refunds.orderId, orderId))).filter(forMainPayment(order));
  const paidCur = order.paidCurrency?.toLowerCase() ?? null;
  const succeeded = rows.filter((r) => r.status === "succeeded" && r.amountMinor !== null);
  const currencyMismatch = paidCur !== null && succeeded.some((r) => (r.currency ?? "").toLowerCase() !== paidCur);
  const sum = succeeded.filter((r) => paidCur === null || (r.currency ?? "").toLowerCase() === paidCur).reduce((s, r) => s + (r.amountMinor ?? 0), 0);
  const open = rows.some((r) => OPEN.includes(r.status) && !r.escalatedAt);
  const escalated = rows.some((r) => OPEN.includes(r.status) && r.escalatedAt);
  const latestLocal = rows.filter((r) => r.source === "local").sort((a, b) => b.attemptNo - a.attemptNo)[0];

  let status = order.status;
  let reviewReason = order.reviewReason;
  let failureReason = order.failureReason;
  let refundedAt: Date | null = order.refundedAt;
  let revoke = false;
  const settleFailure = () => {
    if (escalated) {
      status = "refund_failed";
      reviewReason = "refund_unconfirmed";
    } else if (latestLocal && (latestLocal.status === "failed" || latestLocal.status === "canceled")) {
      status = "refund_failed";
      reviewReason = "refund_failed";
      failureReason = `refund_${latestLocal.status}:${latestLocal.failureReason ?? "unknown"}`;
    }
  };

  if (order.paidAmountMinor === null) {
    // 迁移前的旧单：实收无法核实，不据此判断整单或部分退款
    reviewReason = "payment_unverified";
    if (status === "refund_pending" && !open) settleFailure();
    if (status === "refund_failed" && open) status = "refund_pending";
  } else if (sum > 0 && sum >= order.paidAmountMinor) {
    if (status !== "refunded" && status !== "disputed") {
      status = "refunded";
      refundedAt = new Date();
      revoke = true;
    }
    if (reviewReason && ["partial_refund", "refund_failed", "refund_unconfirmed", "refund_reversed"].includes(reviewReason)) reviewReason = null;
  } else {
    if (status === "refunded") {
      // 先判定为已退款，后来支付方显示退款失败：钱没退回去，交给运营
      status = "refund_failed";
      reviewReason = "refund_reversed";
      refundedAt = null;
    } else if (status === "refund_pending" && !open) {
      settleFailure();
    } else if (status === "refund_failed" && open) {
      // 运营核实：支付方仍在处理，本地误记为失败
      status = "refund_pending";
      reviewReason = null;
    }
    // 待核实订单（金额异常、题意无法还原）保留原来的核实原因：部分退款不能把它冲掉
    if (sum > 0 && status !== "refund_failed" && status !== "needs_review") reviewReason = "partial_refund";
  }
  if (currencyMismatch && status !== "needs_review") reviewReason = "refund_currency_mismatch";

  await tx
    .update(orders)
    .set({
      status,
      reviewReason,
      failureReason,
      refundedAt,
      refundedAmountMinor: sum,
      refundedCurrency: sum > 0 ? (paidCur ?? order.currency.toLowerCase()) : order.refundedCurrency,
      updatedAt: new Date(),
    })
    .where(eq(orders.id, orderId));
  if (revoke) {
    const { revokeOrderContent, releaseReadingIfUnused } = await import("./orders");
    await revokeOrderContent(tx, orderId, "refunded");
    await releaseReadingIfUnused(tx, order.readingId);
  }
  return status;
}

export type ApplyResult =
  | { applied: true; status: RefundStatus; orderStatus: OrderStatus | null }
  | { applied: false; reason: "missing" | "refund_id_mismatch" | "payment_id_mismatch" | "attempt_id_mismatch" | "refund_id_taken" | "needs_verification" };

/**
 * 把支付方的一笔退款写回本地记录并重算订单（同一事务）。
 * source=event：普通回调，只推进未终结的记录；与本地终态矛盾时入队主动核实，不直接改。
 * source=verified：刚向支付方查询到的结果，可以更正本地终态。
 * 两种来源都要求同一笔付款、同一个退款 ID（以及本系统发起的同一条尝试）。
 */
export async function applyProviderRefund(refundRowId: string, r: ProviderRefund, source: "event" | "verified"): Promise<ApplyResult> {
  const db = await getDb();
  return db.transaction(async (tx): Promise<ApplyResult> => {
    const [row] = await tx.select().from(refunds).where(eq(refunds.id, refundRowId)).for("update").limit(1);
    if (!row) return { applied: false, reason: "missing" };
    if (row.providerRefundId && r.refundId && row.providerRefundId !== r.refundId) return { applied: false, reason: "refund_id_mismatch" };
    if (row.providerPaymentId && r.paymentId && row.providerPaymentId !== r.paymentId) return { applied: false, reason: "payment_id_mismatch" };
    if (row.source === "local" && !row.legacyRequest && r.attemptId && r.attemptId !== row.id) return { applied: false, reason: "attempt_id_mismatch" };
    if (!row.providerRefundId && r.refundId) {
      const [taken] = await tx.select({ id: refunds.id }).from(refunds).where(and(eq(refunds.providerRefundId, r.refundId), ne(refunds.id, row.id))).limit(1);
      if (taken) return { applied: false, reason: "refund_id_taken" };
    }
    const next = localStatus(r.status);
    if (source === "event" && TERMINAL.includes(row.status) && row.status !== next) {
      await enqueue(tx, "verify_refund", { refundId: row.id }, { dedupeKey: `verify-refund:${row.id}:${r.refundId}:${next}` });
      return { applied: false, reason: "needs_verification" };
    }
    await tx
      .update(refunds)
      .set({
        providerRefundId: r.refundId || row.providerRefundId,
        providerPaymentId: row.providerPaymentId ?? r.paymentId,
        status: next,
        amountMinor: r.amountMinor,
        currency: r.currency?.toLowerCase() ?? null,
        failureReason: r.failureReason,
        // 核实到了结果：解除"转人工"，恢复自动对账
        escalatedAt: source === "verified" ? null : row.escalatedAt,
        lastCheckedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(refunds.id, row.id));
    return { applied: true, status: next, orderStatus: await recomputeOrderRefunds(tx, row.orderId) };
  });
}

/** 本地明确判定的失败（没有付款编号、支付方拒绝、运营核实支付方查无此退款） */
async function failLocally(refundRowId: string, reason: string): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(refunds)
      .set({ status: "failed", failureReason: reason, escalatedAt: null, lastCheckedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(refunds.id, refundRowId), inArray(refunds.status, OPEN)))
      .returning();
    if (row) await recomputeOrderRefunds(tx, row.orderId);
  });
}

/** 按付款找订单：订单主付款、退款记录里的付款、付款尝试里的付款 */
async function orderForPayment(paymentId: string): Promise<{ id: string; providerPaymentId: string | null } | null> {
  const db = await getDb();
  const [o] = await db.select({ id: orders.id, providerPaymentId: orders.providerPaymentId }).from(orders).where(eq(orders.providerPaymentId, paymentId)).limit(1);
  if (o) return o;
  const [viaRefund] = await db.select({ id: refunds.orderId }).from(refunds).where(eq(refunds.providerPaymentId, paymentId)).limit(1);
  const [viaAttempt] = viaRefund ? [] : await db.select({ id: checkoutAttempts.orderId }).from(checkoutAttempts).where(eq(checkoutAttempts.providerPaymentId, paymentId)).limit(1);
  const id = viaRefund?.id ?? viaAttempt?.id;
  if (!id) return null;
  const [order] = await db.select({ id: orders.id, providerPaymentId: orders.providerPaymentId }).from(orders).where(eq(orders.id, id)).limit(1);
  return order ?? null;
}

/**
 * 把支付方的一笔退款入账：按退款 ID 找记录；没有时按元数据里的尝试 ID 绑定；
 * 迁移前的尝试（没有元数据）只在唯一一条未绑定的旧尝试时关联；其余作为外部退款独立入账。
 */
async function ingestRefund(r: ProviderRefund & { paymentId: string }, source: "event" | "verified"): Promise<{ orderId: string; result: ApplyResult }> {
  const db = await getDb();
  const order = await orderForPayment(r.paymentId);
  if (!order) throw new RefundEventNotReady(`payment ${r.paymentId}`);
  let [row] = await db.select().from(refunds).where(eq(refunds.providerRefundId, r.refundId)).limit(1);
  if (!row && r.attemptId && UUID.test(r.attemptId)) {
    [row] = await db.select().from(refunds).where(and(eq(refunds.id, r.attemptId), eq(refunds.orderId, order.id))).limit(1);
  }
  if (!row && !r.attemptId) {
    const legacy = await db
      .select()
      .from(refunds)
      .where(and(eq(refunds.orderId, order.id), eq(refunds.legacyRequest, true), isNull(refunds.providerRefundId), inArray(refunds.status, OPEN)));
    if (legacy.length === 1) row = legacy[0];
  }
  if (!row) {
    const attemptNo = await nextAttemptNo(db, order.id);
    [row] = await db
      .insert(refunds)
      .values({
        orderId: order.id,
        attemptNo,
        idempotencyKey: `external:${r.refundId}`,
        providerRefundId: r.refundId,
        providerPaymentId: r.paymentId,
        source: "external",
        reason: "initiated_at_provider",
        requestedBy: "provider",
      })
      .onConflictDoNothing()
      .returning();
    if (!row) [row] = await db.select().from(refunds).where(eq(refunds.providerRefundId, r.refundId)).limit(1);
    if (!row) throw new RefundEventNotReady(`refund ${r.refundId}`); // 并发插入撞了尝试编号：让支付方重发
  }
  return { orderId: order.id, result: await applyProviderRefund(row.id, r, source) };
}

/** 按支付方的退款列表重新入账（主动查询，可更正本地误判） */
export async function syncPaymentRefunds(paymentId: string): Promise<string | null> {
  const list = await getPaymentProvider().listRefunds(paymentId);
  let orderId: string | null = null;
  for (const r of list) orderId = (await ingestRefund({ ...r, paymentId }, "verified")).orderId;
  return orderId ?? (await orderForPayment(paymentId))?.id ?? null;
}

/** 任务 refund_order：执行某一次退款尝试。重试时复用同一个幂等键与同样的请求参数 */
export async function runRefundAttempt(refundId: string): Promise<void> {
  requireCapability("payments");
  const db = await getDb();
  const [attempt] = await db.select().from(refunds).where(eq(refunds.id, refundId)).limit(1);
  if (!attempt || !OPEN.includes(attempt.status) || attempt.escalatedAt) return;
  const [order] = await db.select().from(orders).where(eq(orders.id, attempt.orderId)).limit(1);
  if (!order) return;
  const paymentId = attempt.providerPaymentId ?? order.providerPaymentId;
  if (!paymentId) return failLocally(refundId, "no_payment_id");
  await db
    .update(refunds)
    .set({ tries: sql`${refunds.tries} + 1`, providerPaymentId: paymentId, lastCheckedAt: new Date() })
    .where(eq(refunds.id, refundId));
  const provider = getPaymentProvider();
  let result: ProviderRefund;
  if (attempt.providerRefundId) {
    result = await provider.retrieveRefund(attempt.providerRefundId);
  } else {
    try {
      result = await provider.refund({
        paymentId,
        idempotencyKey: attempt.idempotencyKey,
        attemptId: attempt.legacyRequest ? null : attempt.id,
        orderId: order.id,
      });
    } catch (err) {
      if (err instanceof RefundRejectedError) {
        // 支付方明确拒绝（例如已在后台全额退过）：这次尝试没有产生退款；按支付方的退款列表重新入账
        await failLocally(refundId, `rejected:${err.code}`);
        await syncPaymentRefunds(paymentId);
        return;
      }
      throw err; // 结果不明：任务重试，同一幂等键
    }
  }
  await applyProviderRefund(refundId, { ...result, paymentId: result.paymentId ?? paymentId }, "verified");
  await deliverFakeEvents();
}

/** 任务 verify_refund：回调与本地终态矛盾时，主动向支付方查询这一笔退款 */
export async function verifyRefund(refundId: string): Promise<void> {
  requireCapability("payments");
  const db = await getDb();
  const [row] = await db.select().from(refunds).where(eq(refunds.id, refundId)).limit(1);
  if (!row) return;
  const provider = getPaymentProvider();
  if (row.providerRefundId) {
    await applyProviderRefund(row.id, await provider.retrieveRefund(row.providerRefundId), "verified");
  } else if (row.providerPaymentId) {
    const found = (await provider.listRefunds(row.providerPaymentId)).find((r) => r.attemptId === row.id);
    if (found) await applyProviderRefund(row.id, found, "verified");
  }
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

/** 回调：单笔退款状态变化（含外部发起的退款） */
export async function handleRefundUpdated(event: Extract<PaymentEvent, { type: "refund.updated" }>): Promise<string> {
  const { orderId } = await ingestRefund(
    {
      refundId: event.refundId,
      paymentId: event.paymentId,
      attemptId: event.attemptId ?? null,
      status: event.status,
      amountMinor: event.amountMinor,
      currency: event.currency,
      failureReason: event.failureReason,
    },
    "event",
  );
  return orderId;
}

/**
 * 回调：付款的累计退款变化（charge.refunded）。不直接用累计数改订单——按支付方的退款列表逐笔入账；
 * 列表合计仍少于累计数时（流水不全），标记给运营核实。
 */
export async function handleCumulativeRefund(paymentId: string, amountRefundedMinor: number): Promise<string> {
  const orderId = await syncPaymentRefunds(paymentId);
  if (!orderId) throw new RefundEventNotReady(`payment ${paymentId}`);
  const db = await getDb();
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (o && o.providerPaymentId === paymentId && amountRefundedMinor > o.refundedAmountMinor) {
    console.error(`[refunds] provider reports ${amountRefundedMinor} refunded for order ${orderId}, ledger has ${o.refundedAmountMinor}`);
    await db.update(orders).set({ reviewReason: "refund_ledger_incomplete", updatedAt: new Date() }).where(eq(orders.id, orderId));
  }
  return orderId;
}

/**
 * 运营核实后重试。先向支付方核对上一次尝试的真实结果（同一退款 ID；没有 ID 时按尝试 ID 在付款的退款列表里找）：
 * - 支付方显示成功或仍在处理：只同步状态（事务实际更新成功才记"已同步"），不重复退款；
 * - 支付方确认失败或查无此退款：按支付方的退款列表重新入账后，仍未退完才开新尝试。
 */
export async function retryRefundByOps(orderId: string, actor: string, note: string): Promise<string> {
  const db = await getDb();
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new HttpError(404, "not_found");
  const last = await latestLocalAttempt(db, orderId, order.providerPaymentId);
  const failed = last && (last.status === "failed" || last.status === "canceled");
  const unconfirmed = last && OPEN.includes(last.status) && last.escalatedAt;
  if (!last || (!failed && !unconfirmed)) {
    await recordOpsAction({ actor, action: "retry_refund", orderId, result: "rejected:not_failed", note });
    throw new HttpError(409, "refund_not_failed", "上一次退款不是失败或待核实状态，不能重试");
  }
  const provider = getPaymentProvider();
  const paymentId = last.providerPaymentId ?? order.providerPaymentId;
  const current = last.providerRefundId
    ? await provider.retrieveRefund(last.providerRefundId)
    : paymentId
      ? ((await provider.listRefunds(paymentId)).find((r) => r.attemptId === last.id) ?? null)
      : null;
  if (current) {
    const res = await applyProviderRefund(last.id, { ...current, paymentId: current.paymentId ?? paymentId }, "verified");
    if (!res.applied) {
      await recordOpsAction({ actor, action: "retry_refund", orderId, result: `sync_rejected:${res.reason}`, note });
      throw new HttpError(409, "refund_sync_rejected", `支付方返回的退款与本地记录不是同一笔（${res.reason}），未做更改`);
    }
    if (res.status !== "failed" && res.status !== "canceled") {
      await recordOpsAction({ actor, action: "retry_refund", orderId, result: `synced:${res.status}`, note });
      return `支付方显示上一笔退款为 ${res.status}，已同步状态，未重复发起`;
    }
  } else if (unconfirmed) {
    // 支付方查无此退款：确认上一次没有产生退款
    await failLocally(last.id, "not_found_at_provider");
  }
  if (paymentId) {
    const after = await syncPaymentRefunds(paymentId).then(() => db.select().from(orders).where(eq(orders.id, orderId)).limit(1));
    if (after[0]?.status === "refunded") {
      await recordOpsAction({ actor, action: "retry_refund", orderId, result: "synced:already_refunded", note });
      return "支付方显示这笔付款已经退完，已同步状态，未重复发起";
    }
  }
  const created = await db.transaction((tx) => requestRefund(tx, orderId, { reason: "ops_retry", requestedBy: `ops:${actor}`, allowAfterFailure: true }));
  await recordOpsAction({ actor, action: "retry_refund", orderId, result: created?.created ? "requested" : "noop", note });
  return created?.created ? "已开新的退款尝试" : "没有需要重试的退款";
}

/** 结果持续未知的尝试：先在支付方按尝试 ID 找；找不到就转人工核实，不再自动重试（已有的成功退款不受影响） */
async function escalateUnconfirmed(row: RefundRow): Promise<void> {
  const paymentId = row.providerPaymentId;
  if (paymentId) {
    const found = (await getPaymentProvider().listRefunds(paymentId)).find((r) => r.attemptId === row.id);
    if (found) {
      await applyProviderRefund(row.id, found, "verified");
      return;
    }
  }
  const db = await getDb();
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(refunds)
      .set({ escalatedAt: new Date(), failureReason: "unconfirmed_after_retries", updatedAt: new Date() })
      .where(and(eq(refunds.id, row.id), inArray(refunds.status, OPEN), isNull(refunds.escalatedAt)))
      .returning();
    if (updated) await recomputeOrderRefunds(tx, row.orderId);
  });
}

/**
 * 定时对账：长时间未终结的退款向支付方查询；还没拿到支付方编号的，按同一幂等键重新入队，
 * 达到重试上限（或接近幂等键失效）后转人工核实；迁移前遗留的 refund_pending 订单补建第一次尝试（沿用旧幂等键）。
 */
export async function reconcileRefunds(): Promise<number> {
  const db = await getDb();
  const stale = await db
    .select()
    .from(refunds)
    .where(and(inArray(refunds.status, OPEN), isNull(refunds.escalatedAt), lt(refunds.updatedAt, new Date(Date.now() - 15 * 60_000))))
    .limit(100);
  const provider = getPaymentProvider();
  const bucket = Math.floor(Date.now() / (15 * 60_000));
  for (const r of stale) {
    if (r.providerRefundId) {
      await applyProviderRefund(r.id, await provider.retrieveRefund(r.providerRefundId), "verified");
    } else if (r.tries >= MAX_REFUND_TRIES || r.createdAt.getTime() < Date.now() - UNCONFIRMED_AFTER_MS) {
      await escalateUnconfirmed(r);
    } else {
      await db.update(refunds).set({ updatedAt: new Date() }).where(eq(refunds.id, r.id));
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
    await db.transaction((tx) => requestRefund(tx, o.id, { reason: o.reason ?? "legacy_refund", requestedBy: "system", legacyKey: true }));
  }
  await deliverFakeEvents();
  return stale.length + legacy.length;
}

export async function refundAttempts(orderId: string) {
  const db = await getDb();
  return db.select().from(refunds).where(eq(refunds.orderId, orderId)).orderBy(desc(refunds.attemptNo)).limit(10);
}
