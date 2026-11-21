import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "./db/client";
import { checkoutAttempts, orders, type CheckoutAttemptStatus } from "./db/schema";
import { env } from "./env";
import { HttpError } from "./http";
import { enqueue } from "./jobs/queue";
import { CheckoutCreateError, getPaymentProvider, type CheckoutSession, type CheckoutState, type PaymentProvider } from "./payments";

/**
 * 付款尝试（第三轮 P0，附录 F.1）。Stripe 的幂等契约：同一幂等键第一次被执行后保存结果，
 * 之后同一键必须配同样的参数，重放返回同一个结果；参数校验失败的请求不保存结果。由此：
 *
 * 1. 第一次请求前持久化尝试与全部稳定参数（金额、币种、有效期、回跳地址、描述），幂等键 = 尝试 ID；
 *    同一尝试的每次重试原样重放，绝不重算有效期。
 * 2. 失败按"会话是否可能已存在"区分：
 *    - 创建前失败（支付方明确没有创建，例如参数校验失败）→ 尝试标为 failed，可以开新尝试；
 *    - 已创建但响应丢失 / 结果不明 → 同一键重放找回同一会话；重放仍不明时按尝试 ID 在支付方对账，
 *      确认查无此会话才作废；
 *    - 会话已过期或即将过期 → 先向支付方确认它不可支付（必要时主动关闭；关闭时发现已付款就按已付款处理），
 *      再开新尝试。一笔订单同一时刻只有一个未终结的尝试（唯一索引）。
 * 3. 写回会话时在订单行锁下确认订单仍可支付；已删除或作废的订单不返回结账链接，并入队关闭会话。
 */

type Attempt = typeof checkoutAttempts.$inferSelect;
type Order = typeof orders.$inferSelect;

/** 请求里的有效期：Stripe 要求至少 30 分钟；多留 10 分钟，让同一尝试的重放在这段时间内都能通过校验 */
export const CHECKOUT_TTL_MS = 40 * 60_000;
/** 剩余有效期少于这个时长就不再复用，避免用户刚打开就过期 */
export const REUSE_MARGIN_MS = 2 * 60_000;
/** 结果不明的尝试超过这个时长仍查无会话，视为没有创建 */
export const UNKNOWN_SETTLE_MS = 2 * 60_000;
const LIVE: CheckoutAttemptStatus[] = ["creating", "open", "unknown"];
export const CHECKOUT_DESCRIPTION = "问山解读报告（含三次追问）";

type Outcome = { kind: "url"; url: string } | { kind: "paid" } | { kind: "retry" } | { kind: "unavailable"; reason: string } | { kind: "closed" };

const unavailable = (reason: string) => new HttpError(503, "payment_unavailable", "支付服务暂时没有响应，请稍后再点一次（不会重复扣款）", { reason });

async function liveAttempt(orderId: string): Promise<Attempt | null> {
  const db = await getDb();
  const [a] = await db
    .select()
    .from(checkoutAttempts)
    .where(and(eq(checkoutAttempts.orderId, orderId), inArray(checkoutAttempts.status, LIVE)))
    .limit(1);
  return a ?? null;
}

async function openAttempt(order: Order, clientReadingId: string): Promise<Attempt> {
  const db = await getDb();
  const [m] = await db
    .select({ n: sql<number>`coalesce(max(${checkoutAttempts.attemptNo}), 0)::int` })
    .from(checkoutAttempts)
    .where(eq(checkoutAttempts.orderId, order.id));
  const id = randomUUID();
  const [row] = await db
    .insert(checkoutAttempts)
    .values({
      id,
      orderId: order.id,
      attemptNo: (m?.n ?? 0) + 1,
      idempotencyKey: `checkout:${order.id}:${id}`,
      amountMinor: order.amountMinor,
      currency: order.currency,
      successUrl: `${env().APP_URL}/orders/${order.id}?from=checkout`,
      cancelUrl: `${env().APP_URL}/r/${clientReadingId}`,
      description: CHECKOUT_DESCRIPTION,
      requestedExpiresAt: new Date(Date.now() + CHECKOUT_TTL_MS),
    })
    // 并发点击：另一个请求已经开了尝试（唯一索引），复用它
    .onConflictDoNothing()
    .returning();
  const attempt = row ?? (await liveAttempt(order.id));
  if (!attempt) throw new HttpError(409, "order_conflict", "请刷新后重试");
  return attempt;
}

async function setAttempt(id: string, fields: Partial<Attempt>, onlyLive = true): Promise<void> {
  const db = await getDb();
  await db
    .update(checkoutAttempts)
    .set({ ...fields, updatedAt: new Date() })
    .where(onlyLive ? and(eq(checkoutAttempts.id, id), inArray(checkoutAttempts.status, LIVE)) : eq(checkoutAttempts.id, id));
}

/** 记下支付方的会话（尚未判断能否复用），markPaid 才能按会话 ID 找到这次尝试 */
async function bindSession(att: Attempt, s: { sessionId: string; url: string | null; expiresAt: Date | null }): Promise<void> {
  await setAttempt(att.id, { status: "open", providerSessionId: s.sessionId, checkoutUrl: s.url, providerExpiresAt: s.expiresAt, lastError: null });
}

/**
 * 写回可用的会话：在订单行锁下确认订单仍可支付才返回结账链接；
 * 订单已删除或作废时不返回链接，并入队关闭支付方那边的会话（在途付款由任务核对后原路退款）。
 */
async function writeBack(att: Attempt, s: CheckoutSession): Promise<Outcome> {
  const db = await getDb();
  const payable = await db.transaction(async (tx) => {
    const [o] = await tx.select().from(orders).where(eq(orders.id, att.orderId)).for("update").limit(1);
    await tx
      .update(checkoutAttempts)
      .set({ status: "open", providerSessionId: s.sessionId, checkoutUrl: s.url, providerExpiresAt: s.expiresAt, lastError: null, updatedAt: new Date() })
      .where(and(eq(checkoutAttempts.id, att.id), inArray(checkoutAttempts.status, LIVE)));
    const ok = Boolean(o && o.status === "pending_payment" && !o.contentPurgedAt);
    if (ok) {
      await tx
        .update(orders)
        .set({ providerSessionId: s.sessionId, checkoutUrl: s.url, checkoutExpiresAt: s.expiresAt, updatedAt: new Date() })
        .where(eq(orders.id, att.orderId));
    } else {
      await enqueue(tx, "expire_checkout", { orderId: att.orderId }, { dedupeKey: `expire:${att.id}` });
    }
    return ok;
  });
  return payable ? { kind: "url", url: s.url } : { kind: "closed" };
}

/** 确认一个已有会话不可支付：已付款 → 按已付款处理；仍可支付 → 主动关闭；已过期 → 作废 */
async function closeSession(provider: PaymentProvider, att: Attempt, sessionId: string): Promise<Outcome> {
  const { markPaid } = await import("./orders");
  let state: CheckoutState;
  try {
    state = await provider.retrieveCheckout(sessionId);
    if (state.paid) {
      await markPaid(state);
      return { kind: "paid" };
    }
    if (state.status === "open") {
      const r = await provider.expireCheckout(sessionId);
      if (r === "already_complete") {
        await markPaid(await provider.retrieveCheckout(sessionId));
        return { kind: "paid" };
      }
    }
  } catch (err) {
    return { kind: "unavailable", reason: err instanceof Error ? err.message : String(err) };
  }
  await setAttempt(att.id, { status: "expired" });
  return { kind: "retry" };
}

/** 支付方查到的会话：可复用就写回，否则确认不可支付后作废 */
async function adoptFound(provider: PaymentProvider, att: Attempt, found: CheckoutState): Promise<Outcome> {
  await bindSession(att, found);
  if (found.status === "open" && found.url && found.expiresAt && found.expiresAt.getTime() > Date.now() + REUSE_MARGIN_MS) {
    return writeBack(att, { sessionId: found.sessionId, url: found.url, expiresAt: found.expiresAt });
  }
  return closeSession(provider, att, found.sessionId);
}

/** 结果不明的尝试：按尝试 ID（迁移前的尝试按订单号）在支付方对账；超过时限仍查无此会话才作废 */
async function reconcileUnknown(provider: PaymentProvider, att: Attempt, force: boolean): Promise<Outcome | null> {
  const found = await provider.findCheckout({
    attemptId: att.legacy ? null : att.id,
    orderId: att.orderId,
    createdAfter: att.createdAt,
  });
  if (found) return adoptFound(provider, att, found);
  if (force || Date.now() - att.createdAt.getTime() > UNKNOWN_SETTLE_MS) {
    await setAttempt(att.id, { status: "failed", lastError: "not_found_at_provider" });
    return { kind: "retry" };
  }
  return null;
}

async function driveAttempt(provider: PaymentProvider, att: Attempt, email: string): Promise<Outcome> {
  if (att.providerSessionId && att.status === "open") {
    if (att.checkoutUrl && att.providerExpiresAt && att.providerExpiresAt.getTime() > Date.now() + REUSE_MARGIN_MS) {
      return writeBack(att, { sessionId: att.providerSessionId, url: att.checkoutUrl, expiresAt: att.providerExpiresAt });
    }
    return closeSession(provider, att, att.providerSessionId);
  }
  if (att.legacy) {
    // 迁移前的尝试：请求参数没有保存，不能重放，只能对账
    try {
      return (await reconcileUnknown(provider, att, true))!;
    } catch (err) {
      return { kind: "unavailable", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  await setAttempt(att.id, { tries: att.tries + 1 });
  let session: CheckoutSession;
  try {
    session = await provider.createCheckout({
      orderId: att.orderId,
      attemptId: att.id,
      amountMinor: att.amountMinor,
      currency: att.currency,
      email,
      description: att.description,
      successUrl: att.successUrl,
      cancelUrl: att.cancelUrl,
      expiresAt: att.requestedExpiresAt,
      idempotencyKey: att.idempotencyKey,
    });
  } catch (err) {
    const e = err instanceof CheckoutCreateError ? err : new CheckoutCreateError("unknown", err instanceof Error ? err.message : String(err));
    console.error(`[checkout] attempt ${att.id} (${att.attemptNo}) for order ${att.orderId}: ${e.kind}: ${e.message}`);
    if (e.kind === "not_created") {
      await setAttempt(att.id, { status: "failed", lastError: e.message.slice(0, 500) });
      // 全新尝试也被拒：配置问题，不在一次点击里反复开尝试
      return att.tries === 0 ? { kind: "unavailable", reason: e.message } : { kind: "retry" };
    }
    await setAttempt(att.id, { status: "unknown", lastError: `${e.kind}: ${e.message}`.slice(0, 500) });
    try {
      const settled = await reconcileUnknown(provider, att, false);
      if (settled) return settled;
    } catch {
      // 对账也失败：保持 unknown，下次点击或对账任务再试
    }
    return { kind: "unavailable", reason: e.message };
  }
  if (session.expiresAt.getTime() <= Date.now() + REUSE_MARGIN_MS) {
    // 重放拿回的会话已经（或即将）过期：记下会话，确认不可支付后再开新尝试
    await bindSession(att, session);
    return closeSession(provider, att, session.sessionId);
  }
  return writeBack(att, session);
}

/**
 * 为待支付订单拿到可用的结账链接。返回 null 表示订单其实已经付过款（例如旧会话在关闭前被付款）。
 * 支付方暂时无响应时抛 503：尝试与参数都已持久化，用户再点一次会用同一幂等键重放。
 */
export async function ensureCheckout(order: Order, email: string, clientReadingId: string): Promise<string | null> {
  const provider = getPaymentProvider();
  for (let round = 0; round < 3; round++) {
    const att = (await liveAttempt(order.id)) ?? (await openAttempt(order, clientReadingId));
    const out = await driveAttempt(provider, att, email);
    if (out.kind === "url") return out.url;
    if (out.kind === "paid") return null;
    if (out.kind === "closed") throw new HttpError(409, "order_closed", "这笔订单已关闭，请回到结果页重新解锁");
    if (out.kind === "unavailable") throw unavailable(out.reason);
  }
  throw unavailable("too many attempts in one request");
}

/**
 * 任务 expire_checkout：订单已删除或作废，关闭它所有未终结尝试在支付方那边的会话。
 * 支付方显示已经付款（在途付款）时按已支付处理——内容已删，markPaid 会转原路退款。
 * 结果不明、还查不到会话的尝试抛错，让任务稍后重试。
 */
export async function expireCheckoutForOrder(orderId: string): Promise<void> {
  const db = await getDb();
  const provider = getPaymentProvider();
  const { markPaid } = await import("./orders");
  const live = await db.select().from(checkoutAttempts).where(and(eq(checkoutAttempts.orderId, orderId), inArray(checkoutAttempts.status, LIVE)));
  let pending = false;
  for (const att of live) {
    let sessionId = att.providerSessionId;
    if (!sessionId) {
      const found = await provider.findCheckout({ attemptId: att.legacy ? null : att.id, orderId, createdAfter: att.createdAt });
      if (found) {
        await bindSession(att, found);
        sessionId = found.sessionId;
      } else if (Date.now() - att.createdAt.getTime() > UNKNOWN_SETTLE_MS) {
        await setAttempt(att.id, { status: "failed", lastError: "not_found_at_provider" });
        continue;
      } else {
        pending = true;
        continue;
      }
    }
    const r = await provider.expireCheckout(sessionId);
    if (r === "already_complete") await markPaid(await provider.retrieveCheckout(sessionId));
    else await setAttempt(att.id, { status: "expired" });
  }
  if (pending) throw new Error(`checkout attempt outcome for order ${orderId} not settled yet`);
}

/** 支付方告知会话过期（回调）：作废对应尝试；订单仍待支付，下次点击开新尝试 */
export async function expireAttemptBySession(sessionId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(checkoutAttempts)
    .set({ status: "expired", updatedAt: new Date() })
    .where(and(eq(checkoutAttempts.providerSessionId, sessionId), inArray(checkoutAttempts.status, LIVE)));
}

/** 成功页与对账任务：核对订单所有未终结尝试的会话，补收漏掉的付款回调 */
export async function syncOrderCheckouts(orderId: string): Promise<void> {
  const db = await getDb();
  const provider = getPaymentProvider();
  const { markPaid } = await import("./orders");
  const live = await db.select().from(checkoutAttempts).where(and(eq(checkoutAttempts.orderId, orderId), inArray(checkoutAttempts.status, LIVE)));
  for (const att of live) {
    if (att.providerSessionId) {
      const state = await provider.retrieveCheckout(att.providerSessionId);
      if (state.paid) await markPaid(state);
      else if (state.status === "expired") await setAttempt(att.id, { status: "expired" });
    } else if (Date.now() - att.createdAt.getTime() > UNKNOWN_SETTLE_MS) {
      const found = await provider.findCheckout({ attemptId: att.legacy ? null : att.id, orderId, createdAfter: att.createdAt });
      if (!found) await setAttempt(att.id, { status: "failed", lastError: "not_found_at_provider" });
      else if (found.paid) await markPaid(found);
      else if (found.status === "expired") await bindSession(att, found).then(() => setAttempt(att.id, { status: "expired" }));
      else await bindSession(att, found);
    }
  }
}

/** 定时对账：创建 5 分钟以上、两天以内仍未终结的尝试 */
export async function reconcileCheckouts(): Promise<number> {
  const db = await getDb();
  const rows = await db
    .selectDistinct({ orderId: checkoutAttempts.orderId })
    .from(checkoutAttempts)
    .where(
      and(
        inArray(checkoutAttempts.status, LIVE),
        lt(checkoutAttempts.createdAt, new Date(Date.now() - 5 * 60_000)),
        gt(checkoutAttempts.createdAt, new Date(Date.now() - 2 * 24 * 3600_000)),
      ),
    )
    .limit(50);
  for (const { orderId } of rows) await syncOrderCheckouts(orderId);
  return rows.length;
}

/** 订单页：仍在有效期内的结账链接（订单待支付时） */
export async function openCheckoutUrl(orderId: string): Promise<string | null> {
  const db = await getDb();
  const [a] = await db
    .select({ url: checkoutAttempts.checkoutUrl })
    .from(checkoutAttempts)
    .where(and(eq(checkoutAttempts.orderId, orderId), eq(checkoutAttempts.status, "open"), gt(checkoutAttempts.providerExpiresAt, new Date())))
    .orderBy(desc(checkoutAttempts.attemptNo))
    .limit(1);
  return a?.url ?? null;
}

export async function attemptsFor(orderId: string): Promise<Attempt[]> {
  const db = await getDb();
  return db.select().from(checkoutAttempts).where(eq(checkoutAttempts.orderId, orderId)).orderBy(desc(checkoutAttempts.attemptNo));
}

