import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { getDb } from "./db/client";
import { generationAttempts, opsActions, orders, refunds } from "./db/schema";

/** 记录运营的人工操作：谁、何时、对哪笔订单或工单、结果 */
export async function recordOpsAction(input: {
  actor: string;
  action: string;
  orderId?: string | null;
  ticketId?: string | null;
  result: string;
  note?: string | null;
}): Promise<void> {
  const db = await getDb();
  await db.insert(opsActions).values({
    actor: input.actor,
    action: input.action,
    orderId: input.orderId ?? null,
    ticketId: input.ticketId ?? null,
    result: input.result,
    note: input.note?.slice(0, 500) ?? null,
  });
}

export interface OrderException {
  id: string;
  status: string;
  reviewReason: string | null;
  failureReason: string | null;
  amountMinor: number;
  currency: string;
  refundedAmountMinor: number;
  generationCalls: number;
  createdAt: string;
  updatedAt: string;
  refunds: { attemptNo: number; status: string; amountMinor: number | null; failureReason: string | null; requestedBy: string; updatedAt: string }[];
  lastGeneration: { status: string; failureReason: string | null; createdAt: string } | null;
  actions: { actor: string; action: string; result: string; createdAt: string }[];
}

/**
 * 订单异常列表：待核实、退款失败、超过 1 小时仍未完成的退款、生成异常。
 * 异常单自动出现在这里，不需要用户先提工单。
 */
export async function listOrderExceptions(q?: string): Promise<OrderException[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(orders)
    .where(
      and(
        or(
          inArray(orders.status, ["needs_review", "refund_failed", "generation_failed"]),
          and(eq(orders.status, "refund_pending"), lt(orders.updatedAt, new Date(Date.now() - 3600_000))),
          eq(orders.reviewReason, "partial_refund"),
        ),
        q ? sql`${orders.id}::text like ${`${q.trim()}%`}` : undefined,
      ),
    )
    .orderBy(desc(orders.updatedAt))
    .limit(100);
  const out: OrderException[] = [];
  for (const o of rows) {
    const rs = await db.select().from(refunds).where(eq(refunds.orderId, o.id)).orderBy(desc(refunds.attemptNo)).limit(5);
    const [gen] = await db
      .select()
      .from(generationAttempts)
      .where(and(eq(generationAttempts.orderId, o.id), eq(generationAttempts.kind, "report")))
      .orderBy(desc(generationAttempts.createdAt))
      .limit(1);
    const acts = await db.select().from(opsActions).where(eq(opsActions.orderId, o.id)).orderBy(desc(opsActions.createdAt)).limit(5);
    out.push({
      id: o.id,
      status: o.status,
      reviewReason: o.reviewReason,
      failureReason: o.failureReason,
      amountMinor: o.amountMinor,
      currency: o.currency,
      refundedAmountMinor: o.refundedAmountMinor,
      generationCalls: o.generationCalls,
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
      refunds: rs.map((r) => ({
        attemptNo: r.attemptNo,
        status: r.status,
        amountMinor: r.amountMinor,
        failureReason: r.failureReason,
        requestedBy: r.requestedBy,
        updatedAt: r.updatedAt.toISOString(),
      })),
      lastGeneration: gen ? { status: gen.status, failureReason: gen.failureReason, createdAt: gen.createdAt.toISOString() } : null,
      actions: acts.map((a) => ({ actor: a.actor, action: a.action, result: a.result, createdAt: a.createdAt.toISOString() })),
    });
  }
  return out;
}
