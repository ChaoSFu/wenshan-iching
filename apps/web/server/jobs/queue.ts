import { and, eq, lt, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { jobs } from "../db/schema";

/**
 * 基于 Postgres 的任务队列（技术方案 4、5.9）：任务与订单状态在同一事务里写入，
 * 订单变成"已支付"时生成任务一定入队，不会丢。用 FOR UPDATE SKIP LOCKED 取任务，
 * 多个 worker 并行时不会重复执行。
 */

export type JobKind =
  | "generate_report"
  | "generate_followup"
  | "refund_order"
  | "send_report_ready_email"
  | "notify_support_ticket"
  | "expire_checkout";

export interface JobPayloads {
  generate_report: { orderId: string };
  generate_followup: { followupId: string };
  /** refundId 缺省时（迁移前入队的任务）由对账补建尝试 */
  refund_order: { orderId: string; refundId?: string; reason: string };
  send_report_ready_email: { orderId: string };
  notify_support_ticket: { ticketId: string };
  expire_checkout: { orderId: string };
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
  /** 本次认领的标识：续租、完成、失败都必须匹配，租约被接管后旧执行者的更新无效 */
  lockToken: string;
  kind: JobKind;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

export async function claimNext(db: DB): Promise<ClaimedJob | null> {
  const rows = await db.execute(sql`
    update jobs set status = 'running', locked_at = now(), lock_token = gen_random_uuid(), attempts = attempts + 1, updated_at = now()
    where id = (
      select id from jobs
      where status = 'queued' and run_at <= now()
      order by run_at
      for update skip locked
      limit 1
    )
    returning id, kind, payload, attempts, max_attempts, lock_token
  `);
  const row = (rows as unknown as { rows?: Record<string, unknown>[] }).rows?.[0] ?? (rows as unknown as Record<string, unknown>[])[0];
  if (!row) return null;
  return {
    id: String(row.id),
    lockToken: String(row.lock_token),
    kind: row.kind as JobKind,
    payload: row.payload,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
  };
}

const held = (job: Pick<ClaimedJob, "id" | "lockToken">) => and(eq(jobs.id, job.id), eq(jobs.lockToken, job.lockToken), eq(jobs.status, "running"));

/** 完成任务；返回 false 表示租约已被接管，本次结果不写回 */
export async function completeJob(db: DB, job: Pick<ClaimedJob, "id" | "lockToken">): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ status: "done", lockedAt: null, lockToken: null, updatedAt: new Date() })
    .where(held(job))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/** 续租：长任务定期调用；返回 false 表示租约已被接管 */
export async function renewLease(db: DB, job: Pick<ClaimedJob, "id" | "lockToken">): Promise<boolean> {
  const rows = await db.update(jobs).set({ lockedAt: new Date() }).where(held(job)).returning({ id: jobs.id });
  return rows.length > 0;
}

/** 失败后指数退避重试；超过次数标为 failed，返回 true 表示不会再重试 */
export async function failJob(db: DB, job: ClaimedJob, error: unknown, retryable: boolean): Promise<boolean> {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const final = !retryable || job.attempts >= job.maxAttempts;
  const rows = await db
    .update(jobs)
    .set({
      status: final ? "failed" : "queued",
      lastError: message.slice(0, 2000),
      lockedAt: null,
      lockToken: null,
      runAt: final ? undefined : new Date(Date.now() + Math.min(60_000 * 10, 2_000 * 2 ** job.attempts)),
      updatedAt: new Date(),
    })
    .where(held(job))
    .returning({ id: jobs.id });
  // 租约已被接管：失败不写回，也不触发"彻底失败"的善后
  return rows.length > 0 && final;
}

/** 依赖的服务未配置：放回队列稍后再试，不计入重试次数（不会因此走到"彻底失败"的善后） */
export async function deferJob(db: DB, job: ClaimedJob, reason: string, delayMs: number): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({
      status: "queued",
      attempts: sql`greatest(${jobs.attempts} - 1, 0)`,
      lastError: reason.slice(0, 2000),
      lockedAt: null,
      lockToken: null,
      runAt: new Date(Date.now() + delayMs),
      updatedAt: new Date(),
    })
    .where(held(job))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/** 进程崩溃时留下的 running 任务：租约到期后放回队列，由其他（或重启后的）worker 接手 */
export async function requeueStale(db: DB, leaseMs: number): Promise<number> {
  const rows = await db
    .update(jobs)
    .set({ status: "queued", lockedAt: null, lockToken: null, updatedAt: new Date() })
    .where(and(eq(jobs.status, "running"), lt(jobs.lockedAt, new Date(Date.now() - leaseMs))))
    .returning({ id: jobs.id });
  return rows.length;
}
