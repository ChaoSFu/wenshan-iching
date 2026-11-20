/**
 * 独立 worker 进程（npm run worker）：持续运行、重启后接手已付款订单、收到 SIGTERM 正常退出。
 * PGlite 只能被一个进程打开：测试进程先写入数据并关闭，再启动 worker 子进程，结束后重新打开核对。
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { __setDbForTests, migrationsDir, type DB } from "@/server/db/client";
import * as schema from "@/server/db/schema";
import { __setEnvForTests } from "@/server/env";
import { __setMailerForTests } from "@/server/mail";
import { createOrderForReading, handlePaymentEvent } from "@/server/orders";
import { getPaymentProvider } from "@/server/payments";
import { completeFakeCheckout } from "@/server/payments/fake";
import { uploadReading } from "@/server/readings";
import { runTriage } from "@/server/triage";
import { login, sentMail, tossesFor } from "./helpers";

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.resolve(WEB_DIR, "../../node_modules/.bin/tsx");
const KEY = Buffer.alloc(32, 7).toString("base64");

async function open(dir: string) {
  const client = new PGlite(dir);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: migrationsDir() });
  return { client, db: db as unknown as DB };
}

describe("standalone worker process", () => {
  it("keeps running, resumes a paid order left behind by a crashed worker, and stops on SIGTERM", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wenshan-worker-"));
    __setEnvForTests({ PGLITE_DIR: dir, SALES_ENABLED: true, ALLOW_UNREVIEWED_CONTENT: true, DATA_ENCRYPTION_KEY: KEY });
    __setMailerForTests({ send: async (m) => void sentMail.push(m) });
    const first = await open(dir);
    __setDbForTests(first.db);

    const user = await login("worker@example.com");
    const { readingId } = await uploadReading(user.id, {
      clientReadingId: "worker-process-1",
      question: "要不要接下这个外包项目？",
      topicId: "career",
      topicOriginal: "career",
      context: {},
      tosses: tossesFor([9, 7, 7, 7, 7, 7]),
      consent: true,
    });
    await runTriage(user.id, readingId);
    const { orderId } = await createOrderForReading(user, readingId);
    const [o] = await first.db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    const { body, signature } = completeFakeCheckout(o!.providerSessionId!);
    await handlePaymentEvent(getPaymentProvider().parseWebhook(body, new Headers({ "x-fake-signature": signature })));
    // 上一个 worker 认领了任务后崩溃：任务停在 running，订单停在 generating
    await first.db
      .update(schema.jobs)
      .set({ status: "running", lockedAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.jobs.kind, "generate_report"));
    await first.db.update(schema.orders).set({ status: "generating" }).where(eq(schema.orders.id, orderId));
    await first.client.close();

    const child = spawn(TSX, ["scripts/worker.ts"], {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        NODE_ENV: "test",
        PGLITE_DIR: dir,
        DATA_ENCRYPTION_KEY: KEY,
        LLM_PROVIDER: "fake",
        PAYMENT_PROVIDER: "fake",
        MAIL_PROVIDER: "console",
        JOB_LEASE_MS: "500",
        WORKER_POLL_MS: "200",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));

    const deadline = Date.now() + 45_000;
    while (!out.includes("[jobs] done generate_report") && Date.now() < deadline && child.exitCode === null) {
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(out).toContain("worker started (standalone");
    expect(out).toContain("[jobs] done generate_report");

    // 处理完队列后仍然常驻
    await new Promise((r) => setTimeout(r, 1500));
    expect(child.exitCode).toBeNull();

    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(out).toContain("worker stopped");

    const second = await open(dir);
    const [after] = await second.db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    expect(after!.status).toBe("delivered");
    expect(after!.generationCalls).toBe(1);
    expect(await second.db.select().from(schema.reports).where(eq(schema.reports.orderId, orderId))).toHaveLength(1);
    await second.client.close();
  }, 60_000);
});
