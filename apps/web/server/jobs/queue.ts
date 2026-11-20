import { and, eq, lt, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { jobs } from "../db/schema";

/**
 * 基于 Postgres 的任务队列（技术方案 4、5.9）：任务与订单状态在同一事务里写入，
 * 订单变成"已支付"时生成任务一定入队，不会丢。用 FOR UPDATE SKIP LOCKED 取任务，
 * 多个 worker 并行时不会重复执行。
 */

export type JobKind = "generate_report" | "generate_followup" | "refund_order" | "send_report_ready_email" | "notify_support_ticket";

export interface JobPayloads {
  generate_report: { orderId: string };
  generate_followup: { followupId: string };
  refund_order: { orderId: string; reason: string };
  send_report_ready_email: { orderId: string };
  notify_support_ticket: { ticketId: string };
}

type Executor = Pick<DB, "insert">;

export async function enqueue<K extends JobKind>(
  tx: Executor,
  kind: K,
  payload: JobPayloads[K],
  opts: { dedupeKey?: string; runAt?: Date; maxAttempts?: number } = {},
): Promise<void> {
  await tx
    .insert(jobs)
    .values({
      kind,
      payload,
      dedupeKey: opts.dedupeKey ?? null,
      runAt: opts.runAt ?? new Date(),
      maxAttempts: opts.maxAttempts ?? 5,
    })
    .onConflictDoNothing({ target: jobs.dedupeKey });
}

export interface ClaimedJob {
  id: string;
  kind: JobKind;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

export async function claimNext(db: DB): Promise<ClaimedJob | null> {
  const rows = await db.execute(sql`
    update jobs set status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
    where id = (
      select id from jobs
      where status = 'queued' and run_at <= now()
      order by run_at
      for update skip locked
      limit 1
    )
    returning id, kind, payload, attempts, max_attempts
  `);
  const row = (rows as unknown as { rows?: Record<string, unknown>[] }).rows?.[0] ?? (rows as unknown as Record<string, unknown>[])[0];
  if (!row) return null;
  return {
    id: String(row.id),
    kind: row.kind as JobKind,
    payload: row.payload,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
  };
}

export async function completeJob(db: DB, id: string): Promise<void> {
  await db.update(jobs).set({ status: "done", lockedAt: null, updatedAt: new Date() }).where(eq(jobs.id, id));
}

/** 失败后指数退避重试；超过次数标为 failed，返回 true 表示不会再重试 */
export async function failJob(db: DB, job: ClaimedJob, error: unknown, retryable: boolean): Promise<boolean> {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const final = !retryable || job.attempts >= job.maxAttempts;
  await db
    .update(jobs)
    .set({
      status: final ? "failed" : "queued",
      lastError: message.slice(0, 2000),
      lockedAt: null,
      runAt: final ? undefined : new Date(Date.now() + Math.min(60_000 * 10, 2_000 * 2 ** job.attempts)),
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, job.id));
  return final;
}

/** 进程崩溃时留下的 running 任务：租约到期后放回队列，由其他（或重启后的）worker 接手 */
export async function requeueStale(db: DB, leaseMs: number): Promise<number> {
  const rows = await db
    .update(jobs)
    .set({ status: "queued", lockedAt: null, updatedAt: new Date() })
    .where(and(eq(jobs.status, "running"), lt(jobs.lockedAt, new Date(Date.now() - leaseMs))))
    .returning({ id: jobs.id });
  return rows.length;
}
