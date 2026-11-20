import { getDb } from "../db/client";
import { env } from "../env";
import { LlmTransientError } from "../llm";
import { backfillLegacyOrders, reconcilePendingOrders, recoverPaidOrders, refundOverdueOrders, runRefund } from "../orders";
import { generateFollowup, generateReport, onFollowupJobExhausted, onReportJobExhausted, retryFailedGenerations } from "../report/generate";
import { purgeExpiredReports, sendReportReadyEmail } from "../report/service";
import { notifySupportTicket } from "../support";
import { claimNext, completeJob, failJob, requeueStale, type ClaimedJob, type JobPayloads } from "./queue";

type Handler<P> = { run: (p: P) => Promise<unknown>; exhausted?: (p: P) => Promise<void> };

/** 任务处理函数与"彻底失败"时的善后 */
const handlers: { [K in keyof JobPayloads]: Handler<JobPayloads[K]> } = {
  generate_report: { run: (p) => generateReport(p.orderId), exhausted: (p) => onReportJobExhausted(p.orderId) },
  generate_followup: { run: (p) => generateFollowup(p.followupId), exhausted: (p) => onFollowupJobExhausted(p.followupId) },
  refund_order: { run: (p) => runRefund(p.orderId) },
  send_report_ready_email: { run: (p) => sendReportReadyEmail(p.orderId) },
  notify_support_ticket: { run: (p) => notifySupportTicket(p.ticketId) },
};

let logJobs = false;

async function runJob(job: ClaimedJob): Promise<void> {
  const db = await getDb();
  const handler = handlers[job.kind] as Handler<unknown>;
  try {
    await handler.run(job.payload);
    await completeJob(db, job.id);
    if (logJobs) console.info(`[jobs] done ${job.kind} ${job.id}`);
  } catch (err) {
    // 模型、网络、支付平台的临时故障都按可重试处理；数据问题不重试
    const retryable = err instanceof LlmTransientError || !(err instanceof TypeError || err instanceof SyntaxError);
    const final = await failJob(db, job, err, retryable);
    console.error(`[jobs] ${job.kind} ${job.id} attempt ${job.attempts} failed${final ? " (final)" : ""}:`, err instanceof Error ? err.message : err);
    if (final && handler.exhausted) await handler.exhausted(job.payload).catch(() => {});
  }
}

/** 处理队列里已到期的任务，直到队列为空；返回处理的任务数（测试里直接调用） */
export async function drainJobs(limit = 100): Promise<number> {
  const db = await getDb();
  let n = 0;
  for (; n < limit; n++) {
    const job = await claimNext(db);
    if (!job) break;
    await runJob(job);
  }
  return n;
}

/**
 * 定时维护：回收租约到期的任务、补建旧订单快照、恢复已付款未排队的订单、
 * 超时退款、重试生成异常、补收漏掉的回调、清理到期报告。每一步都是幂等的。
 */
export async function runMaintenance(): Promise<void> {
  const db = await getDb();
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`[jobs] maintenance ${name} failed:`, err instanceof Error ? err.message : err);
    }
  };
  await step("requeue", () => requeueStale(db, env().JOB_LEASE_MS));
  await step("legacy", () => backfillLegacyOrders());
  await step("recover", () => recoverPaidOrders());
  await step("refund-overdue", () => refundOverdueOrders());
  await step("retry-failed", () => retryFailedGenerations());
  await step("reconcile", () => reconcilePendingOrders());
  await step("purge", () => purgeExpiredReports());
}

export interface WorkerHandle {
  stop(): Promise<void>;
}

/**
 * 启动任务循环。
 * - inline：在 Next.js 进程里运行，定时器 unref，不阻止 Web 进程退出；
 * - standalone：独立进程（npm run worker），定时器保持进程常驻，收到 SIGTERM 后等当前任务结束再退出。
 */
export function startWorker(opts: { mode: "inline" | "standalone"; pollMs?: number; maintenanceMs?: number }): WorkerHandle {
  const pollMs = opts.pollMs ?? env().WORKER_POLL_MS;
  const maintenanceMs = opts.maintenanceMs ?? 60_000;
  logJobs = opts.mode === "standalone";
  let running: Promise<void> | null = null;
  let stopped = false;

  const tick = () => {
    if (running || stopped) return;
    running = (async () => {
      try {
        await drainJobs();
      } catch (err) {
        console.error("[jobs] loop error:", err instanceof Error ? err.message : err);
      }
    })().finally(() => {
      running = null;
    });
  };
  const maintain = () => {
    if (stopped) return;
    void runMaintenance();
  };

  const poll = setInterval(tick, pollMs);
  const maintenance = setInterval(maintain, maintenanceMs);
  if (opts.mode === "inline") {
    poll.unref?.();
    maintenance.unref?.();
  }
  // 启动时先做一次维护：重启后立刻接手租约到期的任务与已付款订单
  maintain();
  tick();
  console.info(`[jobs] worker started (${opts.mode}, poll ${pollMs}ms)`);

  return {
    async stop() {
      stopped = true;
      clearInterval(poll);
      clearInterval(maintenance);
      if (running) await running;
      console.info("[jobs] worker stopped");
    },
  };
}

const g = globalThis as unknown as { __wenshanWorker?: WorkerHandle };

/** 在 Web 进程里启动（开发与单机部署，WORKER_MODE=inline） */
export function startInlineWorker(): void {
  g.__wenshanWorker ??= startWorker({ mode: "inline" });
}
