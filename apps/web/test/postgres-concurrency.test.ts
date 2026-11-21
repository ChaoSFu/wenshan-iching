/**
 * 真实 PostgreSQL 上的并发验证。PGlite 只有一个连接，事务天然串行，并发冲突只能在真实数据库上验证。
 *
 * TEST_POSTGRES_URL 指向一个可以建库的 PostgreSQL（任意现有库，例如 postgres）；测试自己创建一个
 * 临时数据库 wenshan_test_<pid>_<随机>，跑完自己删除——不会动连接串里的那个库。没有设置时跳过。
 * 一键运行（自动起一个临时 PostgreSQL 集群）：npm run verify
 *
 *   TEST_POSTGRES_URL=postgres://user@127.0.0.1:5432/postgres npx vitest run apps/web/test/postgres-concurrency.test.ts
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { __setDbForTests, migrationsDir, type DB } from "@/server/db/client";
import * as schema from "@/server/db/schema";
import { checkoutAttempts, followups, jobs, orders, paymentEvents, readings, refunds, reports, supportTickets, triageResults } from "@/server/db/schema";
import { __setEnvForTests, isTestDatabaseUrl } from "@/server/env";
import { claimNext, completeJob, enqueue, requeueStale } from "@/server/jobs/queue";
import { drainJobs } from "@/server/jobs/runner";
import { __setLlmForTests, getLlm, type LlmProvider, type StructuredRequest } from "@/server/llm";
import { __setMailerForTests } from "@/server/mail";
import { createOrderForReading, getOrderView, handlePaymentEvent, refundOverdueOrders, requestRefundByOps } from "@/server/orders";
import { __setPaymentProviderForTests, getPaymentProvider } from "@/server/payments";
import { __fakeCheckoutCreates, __fakeExternalRefund, __queueFakeCheckoutFault, __setFakeRefundBehavior, completeFakeCheckout, signFakeEvent } from "@/server/payments/fake";
import { changeTopic, uploadReading } from "@/server/readings";
import { generateReport } from "@/server/report/generate";
import { deleteReport, submitFollowup } from "@/server/report/service";
import { submitTicket } from "@/server/support";
import { runTriage } from "@/server/triage";
import { confirmation, login as loginAt, sentMail, tossesFor } from "./helpers";

const ADMIN_URL = process.env.TEST_POSTGRES_URL;
const enabled = Boolean(ADMIN_URL);

let admin: ReturnType<typeof postgres>;
let client: ReturnType<typeof postgres>;
let db: DB;
let dbName = "";

function urlFor(database: string): string {
  const u = new URL(ADMIN_URL!);
  u.pathname = `/${database}`;
  return u.toString();
}

let ipSeq = 0;
const login = (email: string) => loginAt(email, `10.9.${Math.floor(++ipSeq / 200)}.${ipSeq % 200}`);

describe.skipIf(!enabled)("PostgreSQL concurrency (real connections, real row locks)", () => {
  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} });
    // 自己创建、自己清理的临时库；库名含 test 只是辅助校验
    dbName = `wenshan_test_${process.pid}_${randomBytes(4).toString("hex")}`;
    if (!isTestDatabaseUrl(urlFor(dbName))) throw new Error(`refusing to use ${dbName}`);
    await admin.unsafe(`create database "${dbName}"`);
    client = postgres(urlFor(dbName), { max: 10, onnotice: () => {} });
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
    if (dbName) await admin?.unsafe(`drop database if exists "${dbName}" with (force)`);
    await admin?.end({ timeout: 5 });
  });

  let n = 0;
  async function triaged(user: { id: string }, question = "要不要接下这个外包项目？") {
    const r = await uploadReading(user.id, {
      clientReadingId: `pg-${++n}-xxxxxxxx`,
      question,
      topicId: "career",
      topicOriginal: "career",
      context: {},
      tosses: tossesFor([9, 7, 7, 7, 7, 7]),
      consent: true,
    });
    await runTriage(user.id, r.readingId);
    return { ...r, clientReadingId: `pg-${n}-xxxxxxxx` };
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
    return { user, orderId, reportId: view.reportId!, readingId: r.readingId, clientReadingId: r.clientReadingId };
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

  it("ten simultaneous clicks while the first provider response is lost still yield one provider checkout", async () => {
    const user = await login("pg-lost-clicks@example.com");
    const r = await triaged(user);
    const input = await confirmation(r.readingId);
    const before = __fakeCheckoutCreates();
    __queueFakeCheckoutFault("lose_response");
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => createOrderForReading(user, input)));
    const urls = results.flatMap((x) => (x.status === "fulfilled" && x.value.checkoutUrl ? [x.value.checkoutUrl] : []));
    const retry = await createOrderForReading(user, input);
    expect(new Set([...urls, retry.checkoutUrl]).size).toBe(1);
    expect(__fakeCheckoutCreates() - before).toBe(1);
    const [o] = await db.select().from(orders).where(eq(orders.readingId, r.readingId));
    const atts = await db.select().from(checkoutAttempts).where(eq(checkoutAttempts.orderId, o!.id));
    expect(atts.filter((a) => a.status === "open")).toHaveLength(1);
  });

  it("delivery and the overdue refund racing at the deadline: every order ends with exactly one outcome", async () => {
    const user = await login("pg-deadline@example.com");
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await triaged(user, `要不要接下第 ${i + 1} 个外包项目？`);
      const { orderId } = await createOrderForReading(user, await confirmation(r.readingId));
      await handlePaymentEvent(await webhookFor(orderId));
      ids.push(orderId);
    }
    // 交付期限散布在"现在"前后，让生成交付与超时退款在期限附近真实竞争
    for (const [i, id] of ids.entries()) {
      await db.execute(sql`update orders set refund_due_at = now() + make_interval(secs => ${(i - 6) * 0.05}) where id = ${id}`);
    }
    await Promise.all([...ids.map((id) => generateReport(id)), refundOverdueOrders(), refundOverdueOrders(), refundOverdueOrders()]);
    await new Promise((r) => setTimeout(r, 400));
    await refundOverdueOrders();
    for (const id of ids) {
      const [o] = await db.select().from(orders).where(eq(orders.id, id));
      const reps = await db.select().from(reports).where(eq(reports.orderId, id));
      const rfs = await db.select().from(refunds).where(eq(refunds.orderId, id));
      if (o!.status === "delivered") {
        expect(reps).toHaveLength(1);
        expect(rfs).toHaveLength(0);
      } else {
        expect(o!.status).toBe("refund_pending");
        expect(reps).toHaveLength(0);
        expect(rfs).toHaveLength(1);
      }
    }
    await drainJobs();
  });

  it("a ticket submitted while the report is being deleted never keeps the question", async () => {
    for (let i = 0; i < 6; i++) {
      const { user, orderId, reportId } = await delivered(`pg-ticket-del-${i}@example.com`);
      const key = `pg-ticket-del-${i}-${randomBytes(3).toString("hex")}`;
      await Promise.allSettled([
        submitTicket(
          { idempotencyKey: key, category: "report_content", reportIssues: [], description: "报告里引用的原文好像不对", includeQuestion: true, orderId, diagnostics: {} },
          { user: { id: user.id, email: user.email }, ip: `10.8.0.${i}` },
        ),
        deleteReport(user.id, reportId),
      ]);
      const [t] = await db.select().from(supportTickets).where(eq(supportTickets.idempotencyKey, key));
      if (t) expect(t.questionCt).toBeNull();
    }
    await drainJobs();
  });

  it("a triage call or topic change racing a delete cannot write the cleared question, context or summary back", async () => {
    const base = getLlm();
    __setLlmForTests({
      ...base,
      name: "fake",
      generateStructured: async (req: StructuredRequest) => {
        if (req.route === "triage") await new Promise((r) => setTimeout(r, 30));
        return base.generateStructured(req);
      },
    } as LlmProvider);
    for (let i = 0; i < 4; i++) {
      const d = await delivered(`pg-triage-del-${i}@example.com`);
      await uploadReading(d.user.id, {
        clientReadingId: d.clientReadingId,
        question: `要不要接下这个外包项目？第 ${i + 1} 次修改。`,
        topicId: "career",
        topicOriginal: "career",
        context: {},
        tosses: tossesFor([9, 7, 7, 7, 7, 7]),
        consent: true,
      });
      await Promise.allSettled([runTriage(d.user.id, d.readingId), changeTopic(d.user.id, d.readingId, "study"), deleteReport(d.user.id, d.reportId)]);
      const [rd] = await db.select().from(readings).where(eq(readings.id, d.readingId));
      expect(rd!.questionCt).toBeNull();
      expect(rd!.contextCt).toBeNull();
      const ts = await db.select().from(triageResults).where(eq(triageResults.readingId, d.readingId));
      expect(ts.every((t) => t.outputCt === null)).toBe(true);
    }
    __setLlmForTests(null);
    await drainJobs();
  });

  it("the same provider refund delivered by five concurrent callbacks is booked once", async () => {
    const { orderId } = await delivered("pg-refund-identity@example.com");
    const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
    const refundId = __fakeExternalRefund(o!.providerPaymentId!, 250);
    const events = Array.from({ length: 5 }, (_, i) => {
      const body = JSON.stringify({ id: `evt_pg_dup_${i}_${refundId}`, type: "refund.updated", refundId, paymentId: o!.providerPaymentId, status: "succeeded", amountMinor: 250, currency: "usd", failureReason: null });
      return getPaymentProvider().parseWebhook(body, new Headers({ "x-fake-signature": signFakeEvent(body) }));
    });
    await Promise.allSettled(events.map((e) => handlePaymentEvent(e)));
    // 并发插入撞车的回调返回 503，支付方会重发：再投递一轮
    await Promise.allSettled(events.map((e) => handlePaymentEvent(e)));
    const rows = await db.select().from(refunds).where(eq(refunds.providerRefundId, refundId));
    expect(rows).toHaveLength(1);
    const [after] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(after!.refundedAmountMinor).toBe(250);
  });

  it("leaves no job stuck in running", async () => {
    await drainJobs();
    const running = await db.select().from(jobs).where(inArray(jobs.status, ["running"]));
    expect(running).toHaveLength(0);
  });
});

describe.skipIf(!enabled)("migration 0003 on legacy data (real PostgreSQL)", () => {
  it("backfills provider-confirmed amounts, legacy checkout attempts and refund identity without losing rows", async () => {
    const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const adminConn = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} });
    const name = `wenshan_test_mig_${process.pid}_${randomBytes(4).toString("hex")}`;
    const dir = mkdtempSync(path.join(tmpdir(), "wenshan-mig-"));
    await adminConn.unsafe(`create database "${name}"`);
    const conn = postgres(urlFor(name), { max: 2, onnotice: () => {} });
    try {
      // 1. 只迁移到 0002：模拟第二轮上线后的生产库
      const src = migrationsDir();
      const journal = JSON.parse(readFileSync(path.join(src, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
      mkdirSync(path.join(dir, "meta"));
      const upTo2 = journal.entries.filter((x) => x.tag < "0003");
      for (const x of upTo2) copyFileSync(path.join(src, `${x.tag}.sql`), path.join(dir, `${x.tag}.sql`));
      writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: upTo2 }));
      await migrate(drizzle(conn) as never, { migrationsFolder: dir });

      const [u] = await conn`insert into users (email) values ('legacy@example.com') returning id`;
      const [r] = await conn`insert into readings (user_id, client_reading_id, topic_id, topic_original, tosses, lines, primary_hex, moving_lines,
        cast_version, selection_version, corpus_version, topics_version, model_consent_at)
        values (${u!.id}, 'legacy-reading-1', 'career', 'career', '[]', '[9,7,7,7,7,7]', 1, '[1]', 'v', 'v', 'v', 'v', now()) returning id`;
      const order = async (status: string, extra: { session?: string; payment?: string; review?: string; paid?: boolean; refunded?: number }) => {
        const [o] = await conn`insert into orders (user_id, reading_id, status, amount_minor, currency, price_version, provider,
          provider_session_id, provider_payment_id, checkout_url, checkout_expires_at, paid_at, review_reason, refunded_amount_minor)
          values (${u!.id}, ${r!.id}, ${status}, 990, 'USD', 'price@2026-11', 'stripe', ${extra.session ?? null}, ${extra.payment ?? null},
            ${extra.session ? `https://checkout.example/${extra.session}` : null}, ${extra.session ? new Date(Date.now() + 20 * 60_000).toISOString() : null}::timestamptz,
            ${extra.paid ? new Date().toISOString() : null}::timestamptz, ${extra.review ?? null}, ${extra.refunded ?? 0}) returning id`;
        return o!.id as string;
      };
      const delivered = await order("delivered", { session: "cs_legacy_1", payment: "pi_legacy_1", paid: true, refunded: 400 });
      const mismatch = await order("needs_review", { session: "cs_legacy_2", payment: "pi_legacy_2", paid: true, review: "amount_mismatch" });
      const pending = await order("pending_payment", { session: "cs_legacy_3" });
      const unsent = await order("pending_payment", {});
      // 旧版本按"最近一次进行中的尝试"关联，可能把同一笔支付方退款记成两条
      await conn`insert into refunds (order_id, attempt_no, idempotency_key, provider_refund_id, status, amount_minor, currency, reason, requested_by, created_at)
        values (${delivered}, 1, ${`refund:${delivered}`}, 're_dup', 'succeeded', 400, 'usd', 'complaint', 'ops:a', now() - interval '2 minutes'),
               (${delivered}, 2, ${`external:re_dup`}, 're_dup', 'succeeded', 400, 'usd', 'initiated_at_provider', 'provider', now() - interval '1 minute'),
               (${mismatch}, 1, ${`refund:${mismatch}`}, null, 'requested', null, null, 'amount_mismatch', 'ops:a', now())`;

      // 2. 应用 0003
      await migrate(drizzle(conn) as never, { migrationsFolder: src });

      const os = await conn`select id, paid_amount_minor, paid_currency, refunded_currency from orders`;
      const byId = Object.fromEntries(os.map((o) => [o.id, o]));
      expect(byId[delivered]).toMatchObject({ paid_amount_minor: 990, paid_currency: "usd", refunded_currency: "usd" });
      expect(byId[mismatch]).toMatchObject({ paid_amount_minor: null, paid_currency: null }); // 实收未知，留给运营核实
      expect(byId[pending]!.paid_amount_minor).toBeNull();
      expect(os).toHaveLength(4);

      const atts = await conn`select order_id, attempt_no, status, legacy, provider_session_id, provider_payment_id from checkout_attempts order by provider_session_id`;
      expect(atts.map((a) => [a.order_id, a.status, a.legacy, a.provider_session_id])).toEqual([
        [delivered, "complete", true, "cs_legacy_1"],
        [mismatch, "complete", true, "cs_legacy_2"],
        [pending, "open", true, "cs_legacy_3"],
      ]);
      expect(atts.some((a) => a.order_id === unsent)).toBe(false);

      const rs = await conn`select order_id, attempt_no, provider_refund_id, status, failure_reason, legacy_request, source, provider_payment_id from refunds order by order_id, attempt_no`;
      expect(rs).toHaveLength(3);
      const dup = rs.filter((x) => x.order_id === delivered);
      expect(dup.map((x) => [x.attempt_no, x.provider_refund_id, x.status, x.source])).toEqual([
        [1, "re_dup", "succeeded", "local"],
        [2, null, "canceled", "external"],
      ]);
      expect(dup[1]!.failure_reason).toBe("duplicate_provider_refund_id");
      expect(rs.every((x) => x.legacy_request)).toBe(true);
      expect(rs.find((x) => x.order_id === mismatch)!.provider_payment_id).toBe("pi_legacy_2");
      // 唯一约束已生效：同一支付方退款 ID 不能再记第二条
      await expect(
        conn`insert into refunds (order_id, attempt_no, idempotency_key, provider_refund_id, reason, requested_by) values (${delivered}, 3, 'x', 're_dup', 'r', 'p')`,
      ).rejects.toThrow(/refunds_provider_refund_unique/);
    } finally {
      await conn.end({ timeout: 5 });
      await adminConn.unsafe(`drop database if exists "${name}" with (force)`);
      await adminConn.end({ timeout: 5 });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
