/**
 * 独立的后台任务进程（技术方案 4：生成、重试、退款、清理）。
 * 多实例部署时，Web 进程设 WORKER_MODE=off，另起一个或多个本进程：
 *   npm run worker -w @wenshan/web
 * 任务用 FOR UPDATE SKIP LOCKED 认领，多个 worker 并行不会重复执行。
 */
import { startInlineWorker } from "../server/jobs/runner";

startInlineWorker();
process.on("SIGTERM", () => process.exit(0));
