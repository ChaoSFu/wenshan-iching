import { env } from "./env";

/**
 * Web 进程启动时调用一次（instrumentation.ts，仅 Node.js 运行时）：
 * 1. 校验配置。开放收款（SALES_ENABLED=true）的生产环境缺任何必需配置都直接退出，不带病上线；
 *    关闭收款时只打印哪些能力不可用，免费体验与支持入口照常提供。
 * 2. WORKER_MODE=inline（默认）时在本进程里跑后台任务。
 */
export async function startup(): Promise<void> {
  try {
    env();
  } catch (err) {
    console.error(`[env] ${err instanceof Error ? err.message : err}`);
    if (process.env.NODE_ENV === "production") process.exit(1);
    throw err;
  }
  if ((process.env.WORKER_MODE ?? "inline") !== "inline") return;
  const { startInlineWorker } = await import("./jobs/runner");
  startInlineWorker();
}
