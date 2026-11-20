import { getDb } from "../db/client";
import { LlmTransientError } from "../llm";
import { reconcilePendingOrders, refundOverdueOrders, runRefund } from "../orders";
import { generateFollowup, generateReport, onFollowupJobExhausted, onReportJobExhausted, retryFailedGenerations } from "../report/generate";
import { purgeExpiredReports, sendReportReadyEmail } from "../report/service";
import { claimNext, completeJob, failJob, requeueStale, type ClaimedJob, type JobPayloads } from "./queue";

/** 任务处理函数与"彻底失败"时的善后 */
const handlers: { [K in keyof JobPayloads]: { run: (p: JobPayloads[K]) => Promise<void>; exhausted?: (p: JobPayloads[K]) => Promise<void> } } = {
  generate_report: { run: (p) => generateReport(p.orderId), exhausted: (p) => onReportJobExhausted(p.orderId) },
  generate_followup: { run: (p) => generateFollowup(p.followupId), exhausted: (p) => onFollowupJobExhausted(p.followupId) },
  refund_order: { run: (p) => runRefund(p.orderId) },
  send_report_ready_email: { run: (p) => sendReportReadyEmail(p.orderId) },
};

async function runJob(job: ClaimedJob): Promise<void> {
  const db = await getDb();
  const handler = handlers[job.kind] as { run: (p: unknown) => Promise<void>; exhausted?: (p: unknown) => Promise<void> };
  try {
    await handler.run(job.payload);
    await completeJob(db, job.id);
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

/** 定时维护：超时退款、补收漏掉的回调、清理到期报告、回收卡住的任务 */
export async function runMaintenance(): Promise<void> {
  const db = await getDb();
  await requeueStale(db);
  await refundOverdueOrders();
  await retryFailedGenerations();
  await reconcilePendingOrders().catch((err) => console.error("[jobs] reconcile failed:", (err as Error).message));
  await purgeExpiredReports();
}

const g = globalThis as unknown as { __wenshanWorker?: boolean };

/** 在当前进程里启动任务循环（开发环境与单机部署） */
export function startInlineWorker(): void {
  if (g.__wenshanWorker) return;
  g.__wenshanWorker = true;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await drainJobs();
    } catch (err) {
      console.error("[jobs] loop error:", (err as Error).message);
    } finally {
      busy = false;
    }
  };
  setInterval(tick, 1000).unref?.();
  setInterval(() => void runMaintenance().catch((err) => console.error("[jobs] maintenance error:", (err as Error).message)), 60_000).unref?.();
  console.info("[jobs] inline worker started");
}
