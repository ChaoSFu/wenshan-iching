import { CapabilityUnavailableError, requireCapability } from "../capabilities";
import { getDb } from "../db/client";
import { env } from "../env";
import { LlmTransientError } from "../llm";
import { MailRejectedError } from "../mail";
import { backfillLegacyOrders, expireCheckoutForOrder, reconcilePendingOrders, recoverPaidOrders, refundOverdueOrders } from "../orders";
import { reconcileRefunds, runRefundAttempt, verifyRefund } from "../refunds";
import { generateFollowup, generateReport, onFollowupJobExhausted, onReportJobExhausted, retryFailedGenerations } from "../report/generate";
import { purgeExpiredReports, recoverReadyEmails, sendReportReadyEmail } from "../report/service";
import { notifySupportTicket, purgeOldTickets, recoverTicketNotifications } from "../support";
import { DeferJobError, claimNext, completeJob, deferJob, failJob, renewLease, requeueStale, type ClaimedJob, type JobPayloads } from "./queue";

type Handler<P> = { run: (p: P) => Promise<unknown>; exhausted?: (p: P) => Promise<void> };

/** 任务处理函数与"彻底失败"时的善后 */
const handlers: { [K in keyof JobPayloads]: Handler<JobPayloads[K]> } = {
  generate_report: { run: (p) => generateReport(p.orderId), exhausted: (p) => onReportJobExhausted(p.orderId) },
  generate_followup: { run: (p) => generateFollowup(p.followupId), exhausted: (p) => onFollowupJobExhausted(p.followupId) },
  // 迁移前入队的退款任务没有 refundId：由对账补建第一次尝试（沿用旧幂等键）后执行
  refund_order: { run: (p) => (p.refundId ? runRefundAttempt(p.refundId) : reconcileRefunds()) },
  send_report_ready_email: { run: (p) => sendReportReadyEmail(p.orderId) },
  notify_support_ticket: { run: (p) => notifySupportTicket(p.ticketId) },
  expire_checkout: { run: (p) => expireCheckoutForOrder(p.orderId) },
  verify_refund: { run: (p) => verifyRefund(p.refundId) },
};

let logJobs = false;
/** 缺配置的提示每种只打一次，避免每分钟刷屏 */
const warnedGaps = new Set<string>();
function warnGapOnce(where: string, err: CapabilityUnavailableError) {
  const key = `${where}:${err.capability}`;
  if (warnedGaps.has(key)) return;
  warnedGaps.add(key);
  console.warn(`[jobs] ${where} waiting for ${err.capability} config (${err.missing.join(", ")})`);
}
/** 缺配置时任务延后的间隔 */
const DEFER_MS = 10 * 60_000;

async function runJob(job: ClaimedJob): Promise<void> {
  const db = await getDb();
  const handler = handlers[job.kind] as Handler<unknown>;
  // 长任务定期续租；续租失败说明租约已被接管，本次结果不再写回（副作用由各自的条件更新保证幂等）
  const heartbeat = setInterval(() => void renewLease(db, job).catch(() => {}), Math.max(1000, Math.floor(env().JOB_LEASE_MS / 3)));
  heartbeat.unref?.();
  try {
    await handler.run(job.payload);
    const kept = await completeJob(db, job);
    if (!kept) console.warn(`[jobs] lease of ${job.kind} ${job.id} was taken over; result not recorded`);
    else if (logJobs) console.info(`[jobs] done ${job.kind} ${job.id}`);
  } catch (err) {
    if (err instanceof CapabilityUnavailableError) {
      // 已付款订单的履约与退款各自依赖的服务没配置：延后重试，不消耗次数，也不触发退款等善后
      warnGapOnce(job.kind, err);
      await deferJob(db, job, `${err.capability} unavailable: ${err.missing.join(", ")}`, DEFER_MS);
      return;
    }
    if (err instanceof DeferJobError) {
      await deferJob(db, job, err.message, err.delayMs);
      return;
    }
    // 模型、网络、支付平台的临时故障都按可重试处理；数据问题不重试
    // 邮件服务明确拒绝（发件域名未验证等）不重试
    const retryable = err instanceof LlmTransientError || !(err instanceof TypeError || err instanceof SyntaxError || err instanceof MailRejectedError);
    const final = await failJob(db, job, err, retryable);
    console.error(`[jobs] ${job.kind} ${job.id} attempt ${job.attempts} failed${final ? " (final)" : ""}:`, err instanceof Error ? err.message : err);
    if (final && handler.exhausted) await handler.exhausted(job.payload).catch(() => {});
  } finally {
    clearInterval(heartbeat);
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
      if (err instanceof CapabilityUnavailableError) return warnGapOnce(`maintenance ${name}`, err);
      console.error(`[jobs] maintenance ${name} failed:`, err instanceof Error ? err.message : err);
    }
  };
  await step("requeue", () => requeueStale(db, env().JOB_LEASE_MS));
  await step("legacy", () => backfillLegacyOrders());
  await step("recover", () => recoverPaidOrders());
  await step("refund-overdue", () => refundOverdueOrders());
  await step("retry-failed", () => retryFailedGenerations());
  await step("reconcile", () => reconcilePendingOrders());
  await step("refunds", () => reconcileRefunds());
  await step("notifications", async () => {
    await recoverReadyEmails();
    await recoverTicketNotifications();
  });
  await step("purge", () => purgeExpiredReports());
  await step("tickets", () => purgeOldTickets());
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
  // 没有数据库就没有任务队列：独立 worker 直接报错退出，Web 进程里则不启动（见 startInlineWorker）
  requireCapability("database");
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
  if (g.__wenshanWorker) return;
  try {
    g.__wenshanWorker = startWorker({ mode: "inline" });
  } catch (err) {
    // 关闭收款、尚未配置数据库的生产环境：免费体验照常提供，后台任务不启动
    if (err instanceof CapabilityUnavailableError) console.warn(`[jobs] inline worker not started: ${err.missing.join(", ")} missing`);
    else throw err;
  }
}
