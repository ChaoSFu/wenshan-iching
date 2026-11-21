/**
 * 真实 PostgreSQL 上的并发验证（第二轮交付要求）。PGlite 只有一个连接，事务天然串行，
 * 并发冲突只能在真实数据库上验证。默认跳过；指定一个测试库时运行（库名必须含 test，会被清空重建）：
 *
 *   TEST_POSTGRES_URL=postgres://user@127.0.0.1:5432/wenshan_test npx vitest run apps/web/test/postgres-concurrency.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { __setDbForTests, migrationsDir, type DB } from "@/server/db/client";
import * as schema from "@/server/db/schema";
import { followups, jobs, orders, paymentEvents, refunds, reports } from "@/server/db/schema";
import { __setEnvForTests, isTestDatabaseUrl } from "@/server/env";
import { claimNext, completeJob, enqueue, requeueStale } from "@/server/jobs/queue";
import { drainJobs } from "@/server/jobs/runner";
import { __setLlmForTests } from "@/server/llm";
import { __setMailerForTests } from "@/server/mail";
import { createOrderForReading, getOrderView, handlePaymentEvent, requestRefundByOps } from "@/server/orders";
import { __setPaymentProviderForTests, getPaymentProvider } from "@/server/payments";
import { __fakeCheckoutCreates, __setFakeRefundBehavior, completeFakeCheckout } from "@/server/payments/fake";
import { uploadReading } from "@/server/readings";
import { deleteReport, submitFollowup } from "@/server/report/service";
import { runTriage } from "@/server/triage";
import { confirmation, login, sentMail, tossesFor } from "./helpers";

const URL = process.env.TEST_POSTGRES_URL;
const enabled = Boolean(URL && isTestDatabaseUrl(URL));

let client: ReturnType<typeof postgres>;
let db: DB;

describe.skipIf(!enabled)("PostgreSQL concurrency (real connections, real row locks)", () => {
  beforeAll(async () => {
    client = postgres(URL!, { max: 10, onnotice: () => {} });
    // 只会走到含 test 的库：清空后按迁移重建
    await client.unsafe("drop schema if exists drizzle cascade; drop schema public cascade; create schema public;");
    db = drizzle(client, { schema }) as unknown as DB;
    await migrate(db as never, { migrationsFolder: migrationsDir() });
    __setEnvForTests({ APP_URL: "http://localhost:3000", SALES_ENABLED: true, ALLOW_UNREVIEWED_CONTENT: true, PGLITE_DIR: "memory" });
    __setMailerForTests({ send: async (m) => void sentMail.push(m) });
    __setLlmForTests(null);
    __setPaymentProviderForTests(null);
    __setDbForTests(db);
  }, 60_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
  });

  let n = 0;
  async function triaged(user: { id: string }) {
    const r = await uploadReading(user.id, {
      clientReadingId: `pg-${++n}-xxxxxxxx`,
      question: "要不要接下这个外包项目？",
      topicId: "career",
      topicOriginal: "career",
      context: {},
      tosses: tossesFor([9, 7, 7, 7, 7, 7]),
      consent: true,
    });
    await runTriage(user.id, r.readingId);
    return r;
  }
  async function webhookFor(orderId: string) {
    const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
    const { body, signature } = completeFakeCheckout(o!.providerSessionId!);
    return getPaymentProvider().parseWebhook(body, new Headers({ "x-fake-signature": signature }));
  }
  async function delivered(email: string) {
    const user = await login(email);
    const r = await triaged(user);
    const { orderId } = await createOrderForReading(user, await confirmation(r.readingId));
    await handlePaymentEvent(await webhookFor(orderId));
    await drainJobs();
    const view = await getOrderView(user.id, orderId);
    expect(view.status).toBe("delivered");
    return { user, orderId, reportId: view.reportId! };
  }

  it("ten simultaneous checkout clicks create one order and one provider checkout", async () => {
    const user = await login("pg-clicks@example.com");
    const r = await triaged(user);
    const input = await confirmation(r.readingId);
    const before = __fakeCheckoutCreates();
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => createOrderForReading(user, input)));
    const okIds = results.flatMap((x) => (x.status === "fulfilled" ? [x.value.orderId] : []));
    expect(okIds.length).toBeGreaterThan(0);
    expect(new Set(okIds).size).toBe(1);
    expect(__fakeCheckoutCreates() - before).toBe(1);
    const rows = await db.select().from(orders).where(eq(orders.readingId, r.readingId));
    expect(rows).toHaveLength(1);
  });

  it("the same paid webhook delivered ten times at once marks the order paid once and queues one report", async () => {
    const user = await login("pg-webhook@example.com");
    const r = await triaged(user);
    const { orderId } = await createOrderForReading(user, await confirmation(r.readingId));
    const event = await webhookFor(orderId);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => handlePaymentEvent(event)));
    expect(results.filter((x) => x.status === "fulfilled").length).toBeGreaterThan(0);
    const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(o!.status).toBe("paid");
    const genJobs = await db.select().from(jobs).where(and(eq(jobs.kind, "generate_report"), sql`${jobs.payload}->>'orderId' = ${orderId}`));
    expect(genJobs).toHaveLength(1);
    expect(await db.select().from(refunds).where(eq(refunds.orderId, orderId))).toHaveLength(0);
    expect(await db.select().from(paymentEvents).where(eq(paymentEvents.eventId, event.id))).toHaveLength(1);
    await drainJobs();
  });

  it("six workers claiming at once never run the same job twice (SKIP LOCKED), and a stale worker cannot complete a taken-over job", async () => {
    await drainJobs();
    // 不存在的订单：expire_checkout 处理时直接返回，这里只验证认领
    for (let i = 0; i < 30; i++) await enqueue(db, "expire_checkout", { orderId: crypto.randomUUID() });
    const ids = (await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.kind, "expire_checkout"), eq(jobs.status, "queued")))).map((j) => j.id);
    expect(ids).toHaveLength(30);
    const claimed: string[] = [];
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (;;) {
          const job = await claimNext(db);
          if (!job) return;
          claimed.push(job.id);
          await completeJob(db, job);
        }
      }),
    );
    expect(claimed.filter((id) => ids.includes(id)).sort()).toEqual([...ids].sort());
    expect(new Set(claimed).size).toBe(claimed.length);

    // 租约接管：A 认领后卡住，租约到期被 B 接手；A 迟到的完成不能覆盖 B
    await enqueue(db, "expire_checkout", { orderId: crypto.randomUUID() });
    const a = (await claimNext(db))!;
    await db.update(jobs).set({ lockedAt: new Date(Date.now() - 3600_000) }).where(eq(jobs.id, a.id));
    expect(await requeueStale(db, 60_000)).toBeGreaterThanOrEqual(1);
    const b = (await claimNext(db))!;
    expect(b.id).toBe(a.id);
    expect(b.lockToken).not.toBe(a.lockToken);
    expect(await completeJob(db, a)).toBe(false);
    expect(await completeJob(db, b)).toBe(true);
  });

  it("six simultaneous follow-ups on three remaining credits: exactly three are accepted", async () => {
    const { user, orderId, reportId } = await delivered("pg-followups@example.com");
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => submitFollowup(user.id, reportId, `我没有产品项目，第 ${i + 1} 种做法是什么？`, `pg-followup-key-${i}`)),
    );
    const accepted = results.filter((x) => x.status === "fulfilled");
    const rejected = results.filter((x) => x.status === "rejected") as PromiseRejectedResult[];
    expect(accepted).toHaveLength(3);
    expect(rejected.every((x) => (x.reason as { code?: string }).code === "no_followups_left")).toBe(true);
    const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(o!.followupsUsed).toBe(3);
    expect(await db.select().from(followups).where(eq(followups.orderId, orderId))).toHaveLength(3);
    await drainJobs();
  });

  it("deleting a report while follow-ups are being submitted leaves no answer behind", async () => {
    const { user, orderId, reportId } = await delivered("pg-delete-race@example.com");
    await Promise.allSettled([
      submitFollowup(user.id, reportId, "我没有产品项目，可以拿哪种后端项目当案例？", "pg-race-1"),
      deleteReport(user.id, reportId),
      submitFollowup(user.id, reportId, "如果试了两周没进展，要停吗？", "pg-race-2"),
    ]);
    await drainJobs();
    const fus = await db.select().from(followups).where(eq(followups.orderId, orderId));
    expect(fus.filter((f) => f.status === "done" || f.answerCt !== null)).toHaveLength(0);
    const [rep] = await db.select().from(reports).where(eq(reports.id, reportId));
    expect(rep!.contentCt).toBeNull();
    const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(o!.contentPurgedAt).not.toBeNull();
    expect(o!.intentCt).toBeNull();
  });

  it("three operators refunding the same order at once create one refund attempt", async () => {
    __setFakeRefundBehavior("succeed_sync");
    const { orderId } = await delivered("pg-refund-race@example.com");
    await Promise.allSettled(Array.from({ length: 3 }, (_, i) => requestRefundByOps(orderId, "用户反馈，核实后退款", `ops-${i}`)));
    await drainJobs();
    const attempts = await db.select().from(refunds).where(eq(refunds.orderId, orderId));
    expect(attempts).toHaveLength(1);
    const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(o!.status).toBe("refunded");
    expect(o!.refundedAmountMinor).toBe(o!.amountMinor);
  });

  it("leaves no job stuck in running", async () => {
    await drainJobs();
    const running = await db.select().from(jobs).where(inArray(jobs.status, ["running"]));
    expect(running).toHaveLength(0);
  });
});
