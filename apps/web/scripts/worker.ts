/**
 * 独立的后台任务进程（技术方案 4：生成、重试、退款、清理、工单通知）。
 * 多实例部署时，Web 进程设 WORKER_MODE=off，另起一个或多个本进程：
 *   npm run worker -w @wenshan/web
 * 任务用 FOR UPDATE SKIP LOCKED 认领，多个 worker 并行不会重复执行；
 * 进程崩溃后，running 任务在租约（JOB_LEASE_MS）到期后由其他或重启后的 worker 接手。
 *
 * 注意：PGlite 只能被一个进程打开。本地用 PGlite 时，独立 worker 不能和 npm run dev 同时运行。
 */
import { existsSync } from "node:fs";

// 模拟模式（集成测试、dev:test）不读本地配置文件：里面可能有真实数据库与密钥。
// 正常模式读取 .env.local / .env，已存在的环境变量优先。
if (process.env.RUN_MODE !== "simulation") {
  for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f);
}

const { startWorker } = await import("../server/jobs/runner");
let worker: Awaited<ReturnType<typeof startWorker>>;
try {
  // 配置校验（含模拟模式只能连测试库）在这里完成，之后才会连接数据库
  worker = startWorker({ mode: "standalone" });
} catch (err) {
  console.error(`[jobs] worker cannot start: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.info(`[jobs] ${signal} received, finishing current job…`);
  await worker.stop();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
