/** Next.js 服务启动时调用一次：WORKER_MODE=inline（默认）时在本进程里跑后台任务 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if ((process.env.WORKER_MODE ?? "inline") !== "inline") return;
  const { startInlineWorker } = await import("./server/jobs/runner");
  startInlineWorker();
}
