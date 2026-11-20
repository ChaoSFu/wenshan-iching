/**
 * 首发改造的验收测试（见 docs/technical-design.md 附录 D）：
 * 1 重复付款退款不影响原订单；2 退款与生成并发、题意修订；3 收款开关与审核门槛；
 * 4 worker 次数上限、恢复与租约；5 工单；6 模型路由与成本口径。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { castFromTosses, tossesFromLines } from "@wenshan/iching-core";
import { __setEnvForTests, type Env } from "@/server/env";
import type { DB } from "@/server/db/client";
import { generationAttempts, jobs, orders, readings, reports, supportTickets } from "@/server/db/schema";
import { drainJobs, runMaintenance } from "@/server/jobs/runner";
import { __setLlmForTests, buildResponsesRequest, getLlm, routeConfig, type LlmProvider, type StructuredRequest } from "@/server/llm";
import { costSummary, costUsd } from "@/server/llm/usage";
import { __setMailerForTests, type Mailer } from "@/server/mail";
import { createOrderForReading, getOrderView, handlePaymentEvent, requestRefundByOps } from "@/server/orders";
import { getPaymentProvider } from "@/server/payments";
import { completeFakeCheckout, signFakeEvent } from "@/server/payments/fake";
import { adoptReframe, uploadReading } from "@/server/readings";
import { generateReport } from "@/server/report/generate";
import { getReportView, submitFollowup } from "@/server/report/service";
import { listTickets, requireOps, submitTicket, updateTicketStatus } from "@/server/support";
import { runTriage } from "@/server/triage";
import { login, sentMail, setupTestServer, tossesFor } from "./helpers";

const BASE: Partial<Env> = {
  PGLITE_DIR: "memory",
  APP_URL: "http://localhost:3000",
  SALES_ENABLED: true,
  ALLOW_UNREVIEWED_CONTENT: true,
  OPS_EMAILS: "ops@example.com",
};
/** 只改配置，不重建数据库 */
function setEnv(overrides: Partial<Env> = {}): void {
  __setEnvForTests({ ...BASE, ...overrides });
}

let db: DB;
beforeAll(async () => {
  db = await setupTestServer(BASE);
});

let seq = 0;
async function reading(user: { id: string }, question = "我做后端，想转产品岗，接下来四周怎么试？", lines = [9, 7, 7, 7, 7, 7] as const) {
  const clientReadingId = `launch-${++seq}-xxxxxxxx`;
  const r = await uploadReading(user.id, {
    clientReadingId,
    question,
    topicId: "career",
    topicOriginal: "career",
    context: { options: "留在现岗位；内部转产品岗" },
    tosses: tossesFor([...lines]),
    consent: true,
  });
  return { ...r, clientReadingId };
}

async function pay(orderId: string) {
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  const { body, signature } = completeFakeCheckout(o!.providerSessionId!);
  const event = getPaymentProvider().parseWebhook(body, new Headers({ "x-fake-signature": signature }));
  return handlePaymentEvent(event);
}

async function refundEvent(orderId: string, amount: number) {
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  const body = JSON.stringify({ id: `evt_${Math.random()}`, type: "refund.succeeded", paymentId: o!.providerPaymentId, amountRefundedMinor: amount, currency: "usd" });
  return handlePaymentEvent(getPaymentProvider().parseWebhook(body, new Headers({ "x-fake-signature": signFakeEvent(body) })));
}

async function boughtAndDelivered(user: { id: string; email: string }) {
  const r = await reading(user);
  await runTriage(user.id, r.readingId);
  const { orderId } = await createOrderForReading(user, r.readingId);
  await pay(orderId);
  await drainJobs();
  const view = await getOrderView(user.id, orderId);
  return { ...r, orderId, reportId: view.reportId! };
}

describe("1 · duplicate payment refund keeps the original order intact", () => {
  it("refunds the second payment; the first report still opens and accepts a follow-up", async () => {
    const user = await login("dup@example.com");
    const r = await reading(user);
    await runTriage(user.id, r.readingId);
    const first = await createOrderForReading(user, r.readingId);
    await db.update(orders).set({ checkoutExpiresAt: new Date(Date.now() - 1000) }).where(eq(orders.id, first.orderId));
    const second = await createOrderForReading(user, r.readingId);
    expect(second.orderId).not.toBe(first.orderId);

    await pay(first.orderId);
    await pay(second.orderId);
    await drainJobs();
    expect((await getOrderView(user.id, second.orderId)).status).toBe("refunded");
    const firstView = await getOrderView(user.id, first.orderId);
    expect(firstView.status).toBe("delivered");

    const report = await getReportView(user.id, firstView.reportId!);
    expect("deleted" in report).toBe(false);
    const fu = await submitFollowup(user.id, firstView.reportId!, "访谈前要准备哪些问题？", "dup-followup-1");
    expect(fu.status).toBe("queued");
    await drainJobs();
    const after = await getReportView(user.id, firstView.reportId!);
    if ("deleted" in after) throw new Error("report unexpectedly unavailable");
    expect(after.followups[0]?.status).toBe("done");
    // 共享的阅读数据仍在
    const [row] = await db.select().from(readings).where(eq(readings.id, r.readingId));
    expect(row!.questionCt).not.toBeNull();
  });

  it("delivers once per payment even if the webhook and success page both confirm", async () => {
    const user = await login("once@example.com");
    const { orderId } = await boughtAndDelivered(user);
    const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
    const { body, signature } = completeFakeCheckout(o!.providerSessionId!);
    await handlePaymentEvent(getPaymentProvider().parseWebhook(body, new Headers({ "x-fake-signature": signature })));
    await drainJobs();
    const rows = await db.select().from(reports).where(eq(reports.orderId, orderId));
    expect(rows).toHaveLength(1);
  });
});

describe("2 · refunds racing generation, partial refunds, and frozen intent", () => {
  it("discards a report that finishes after the refund has taken effect", async () => {
    const user = await login("race@example.com");
    const r = await reading(user);
    await runTriage(user.id, r.readingId);
    const { orderId } = await createOrderForReading(user, r.readingId);
    await pay(orderId);
    // 生成进行中，退款回调先到并生效
    const base = getLlm();
    __setLlmForTests({
      ...base,
      name: "fake",
      generateStructured: async (req: StructuredRequest) => {
        if (req.route === "report") await refundEvent(orderId, 990);
        return base.generateStructured(req);
      },
    } as LlmProvider);
    expect(await generateReport(orderId)).toBe("discarded");
    __setLlmForTests(null);
    const v = await getOrderView(user.id, orderId);
    expect(v.status).toBe("refunded");
    expect(v.reportId).toBeNull();
    expect(await db.select().from(reports).where(eq(reports.orderId, orderId))).toHaveLength(0);
  });

  it("keeps access after a partial refund and revokes it after a full refund", async () => {
    const user = await login("partial@example.com");
    const { orderId, reportId } = await boughtAndDelivered(user);
    await refundEvent(orderId, 300);
    let v = await getOrderView(user.id, orderId);
    expect(v.status).toBe("delivered");
    expect(v.refundedAmountMinor).toBe(300);
    expect(v.reviewReason).toBe("partial_refund");
    expect("deleted" in (await getReportView(user.id, reportId))).toBe(false);
    await refundEvent(orderId, 990);
    v = await getOrderView(user.id, orderId);
    expect(v.status).toBe("refunded");
    expect(await getReportView(user.id, reportId)).toMatchObject({ deleted: true });
  });

  it("asks the payment platform to retry a refund event that arrives before the payment", async () => {
    const body = JSON.stringify({ id: "evt_early_refund", type: "refund.succeeded", paymentId: "pi_not_yet", amountRefundedMinor: 990, currency: "usd" });
    const ev = getPaymentProvider().parseWebhook(body, new Headers({ "x-fake-signature": signFakeEvent(body) }));
    await expect(handlePaymentEvent(ev)).rejects.toMatchObject({ status: 503 });
  });

  it("rejects an old triage result after the question is edited", async () => {
    const user = await login("revision@example.com");
    const r = await reading(user, "要不要接下这个外包项目？");
    await runTriage(user.id, r.readingId);
    // 改了问题：修订号 +1，旧分流结果失效
    const edited = await uploadReading(user.id, {
      clientReadingId: r.clientReadingId,
      question: "要不要接下这个外包项目？预算只有一半。",
      topicId: "career",
      topicOriginal: "career",
      context: {},
      tosses: tossesFor([9, 7, 7, 7, 7, 7]),
      consent: true,
    });
    expect(edited.revision).toBe(r.revision + 1);
    await expect(createOrderForReading(user, r.readingId)).rejects.toMatchObject({ code: "triage_required" });
    const t = await runTriage(user.id, r.readingId);
    expect(t.revision).toBe(edited.revision);
    expect((await createOrderForReading(user, r.readingId)).checkoutUrl).toBeTruthy();
  });

  it("requires adopting the rewrite for outcome questions, then freezes the adopted wording", async () => {
    const user = await login("reframe@example.com");
    const r = await reading(user, "这场官司能不能赢？");
    const t1 = await runTriage(user.id, r.readingId);
    expect(t1.decision).toBe("reframe_required");
    await expect(createOrderForReading(user, r.readingId)).rejects.toMatchObject({ code: "reframe_required" });

    await adoptReframe(user.id, r.readingId, t1.reframe!);
    const t2 = await runTriage(user.id, r.readingId);
    expect(t2.decision).toBe("proceed");
    const { orderId } = await createOrderForReading(user, r.readingId);
    await pay(orderId);
    // 付款后用户又改了问题：报告仍按下单时冻结的题意生成
    await uploadReading(user.id, {
      clientReadingId: r.clientReadingId,
      question: "完全不同的另一件事",
      topicId: "career",
      topicOriginal: "career",
      context: {},
      tosses: tossesFor([9, 7, 7, 7, 7, 7]),
      consent: true,
    });
    await drainJobs();
    const v = await getOrderView(user.id, orderId);
    const report = await getReportView(user.id, v.reportId!);
    if ("deleted" in report) throw new Error("deleted");
    expect(report.question).toBe(t1.reframe);
  });

  it("reuses the triage result for the same revision instead of calling the model again", async () => {
    const user = await login("reuse@example.com");
    const r = await reading(user, "要不要换个城市生活？");
    const a = await runTriage(user.id, r.readingId);
    const b = await runTriage(user.id, r.readingId);
    expect(b.reused).toBe(true);
    expect(b.triageId).toBe(a.triageId);
    const calls = await db.select().from(generationAttempts).where(and(eq(generationAttempts.readingId, r.readingId), eq(generationAttempts.kind, "triage")));
    expect(calls).toHaveLength(1);
  });
});

describe("3 · sales switch and release review gate", () => {
  it("refuses checkout while sales are closed; the free reading needs no server", async () => {
    setEnv({ SALES_ENABLED: false });
    const user = await login("closed@example.com");
    const r = await reading(user);
    await runTriage(user.id, r.readingId);
    await expect(createOrderForReading(user, r.readingId)).rejects.toMatchObject({ status: 403, code: "sales_closed" });
    // 免费起卦与选文是纯前端计算，不受影响
    expect(castFromTosses(tossesFromLines([9, 7, 7, 7, 7, 7])).primary).toBe(1);
    setEnv();
  });

  it("refuses checkout when required passages are still drafts (strict review)", async () => {
    setEnv({ ALLOW_UNREVIEWED_CONTENT: false });
    const user = await login("strict@example.com");
    const r = await reading(user);
    await runTriage(user.id, r.readingId);
    const err = await createOrderForReading(user, r.readingId).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: "content_pending" });
    expect((err as { details: { pending: unknown[] } }).details.pending.length).toBeGreaterThan(0);
    setEnv();
  });

  it("never allows unreviewed content together with real Stripe checkout", async () => {
    const m = await import("@/server/env");
    const saved = { ...process.env };
    Object.assign(process.env, { PAYMENT_PROVIDER: "stripe", ALLOW_UNREVIEWED_CONTENT: "true", STRIPE_SECRET_KEY: "sk_test_x" });
    m.__resetEnvCache();
    expect(() => m.env()).toThrow(/ALLOW_UNREVIEWED_CONTENT/);
    process.env = saved;
    setEnv();
  });
});

describe("4 · worker limits, recovery and leases", () => {
  it("stops calling the model once the per-order limit is reached", async () => {
    setEnv({ MAX_REPORT_CALLS_PER_ORDER: 3 });
    const user = await login("limit@example.com");
    const r = await reading(user);
    await runTriage(user.id, r.readingId);
    let reportCalls = 0;
    const base = getLlm();
    __setLlmForTests({
      ...base,
      name: "fake",
      generateStructured: async (req: StructuredRequest) => {
        if (req.route !== "report") return base.generateStructured(req);
        reportCalls++;
        return { kind: "ok", data: { bad: true }, model: "stub", effort: "low", latencyMs: 1, usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, reasoningTokens: 0 } };
      },
    } as LlmProvider);
    const { orderId } = await createOrderForReading(user, r.readingId);
    await pay(orderId);
    await drainJobs(); // 2 次调用
    await generateReport(orderId); // 第 3 次后达到上限
    await generateReport(orderId); // 不再调用模型
    __setLlmForTests(null);
    expect(reportCalls).toBe(3);
    const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(o!.generationCalls).toBe(3);
    expect(o!.failureReason).toBe("call_limit_reached");
    setEnv();
  });

  it("re-queues a paid order whose job was lost, and reclaims jobs whose lease expired", async () => {
    setEnv({ JOB_LEASE_MS: 1000 });
    const user = await login("recover@example.com");
    const r = await reading(user);
    await runTriage(user.id, r.readingId);
    const { orderId } = await createOrderForReading(user, r.readingId);
    await pay(orderId);
    // 模拟 worker 在认领任务后崩溃：任务停在 running，租约已过期
    await db.update(jobs).set({ status: "running", lockedAt: new Date(Date.now() - 60_000) }).where(eq(jobs.kind, "generate_report"));
    await runMaintenance();
    await drainJobs();
    expect((await getOrderView(user.id, orderId)).status).toBe("delivered");

    // 任务彻底丢失（例如被标为失败）的已付款订单
    const r2 = await reading(user);
    await runTriage(user.id, r2.readingId);
    const o2 = await createOrderForReading(user, r2.readingId);
    await pay(o2.orderId);
    await db.delete(jobs).where(eq(jobs.kind, "generate_report"));
    await db.update(orders).set({ paidAt: new Date(Date.now() - 5 * 60_000) }).where(eq(orders.id, o2.orderId));
    await runMaintenance();
    await drainJobs();
    expect((await getOrderView(user.id, o2.orderId)).status).toBe("delivered");
    setEnv();
  });

  it("rebuilds the snapshot for a legacy order when the reading was not edited, otherwise routes it to review", async () => {
    const user = await login("legacy@example.com");
    const r = await reading(user);
    await runTriage(user.id, r.readingId);
    const { orderId } = await createOrderForReading(user, r.readingId);
    // 模拟迁移前的订单：没有快照
    await db.update(orders).set({ basis: null, intentCt: null, createdAt: new Date(Date.now() + 1000) }).where(eq(orders.id, orderId));
    await runMaintenance();
    const [rebuilt] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(rebuilt!.basis).not.toBeNull();

    const r2 = await reading(user);
    await runTriage(user.id, r2.readingId);
    const o2 = await createOrderForReading(user, r2.readingId);
    await pay(o2.orderId);
    await db
      .update(orders)
      .set({ basis: null, intentCt: null, status: "generation_failed", createdAt: new Date(Date.now() - 3600_000) })
      .where(eq(orders.id, o2.orderId));
    await runMaintenance();
    const v = await getOrderView(user.id, o2.orderId);
    expect(v.status).toBe("needs_review");
    expect(v.reviewReason).toBe("legacy_intent_unrecoverable");
  });
});

describe("5 · support tickets", () => {
  it("accepts tickets from guests, payers and report readers, linking only what they own", async () => {
    const guest = await submitTicket(
      { idempotencyKey: "guest-ticket-1", category: "login_or_page_error", reportIssues: [], description: "验证码一直收不到", includeQuestion: false, diagnostics: { page: "/unlock/abc?x=1", errorCode: "otp_failed" } },
      { user: null, ip: "9.9.9.9" },
    );
    expect(guest.ticketNo).toMatch(/^WS-\d{6}-[A-Z0-9]{5}$/);

    const payer = await login("payer@example.com");
    const { orderId, reportId } = await boughtAndDelivered(payer);
    const paid = await submitTicket(
      { idempotencyKey: "payer-ticket-1", category: "paid_not_delivered", reportIssues: [], description: "付款后页面一直转圈", orderId, includeQuestion: false, diagnostics: {} },
      { user: payer, ip: "8.8.8.8" },
    );
    expect(paid.linkedOrder).toBe(true);

    const stranger = await login("stranger@example.com");
    const notMine = await submitTicket(
      { idempotencyKey: "stranger-ticket-1", category: "other", reportIssues: [], description: "想看看别人的订单", orderId, reportId, includeQuestion: true, diagnostics: {} },
      { user: stranger, ip: "7.7.7.7" },
    );
    expect(notMine).toMatchObject({ linkedOrder: false, linkedReport: false });

    const reportTicket = await submitTicket(
      {
        idempotencyKey: "report-ticket-1",
        category: "report_content",
        reportIssues: ["bad_citation", "vague_action"],
        description: "第二条引用和解释对不上",
        reportId,
        includeQuestion: true,
        diagnostics: { page: `/reports/${reportId}` },
      },
      { user: payer, ip: "8.8.8.8" },
    );
    expect(reportTicket.linkedReport).toBe(true);
    // 同一个幂等键不重复写入
    const again = await submitTicket(
      { idempotencyKey: "report-ticket-1", category: "report_content", reportIssues: [], description: "重复提交", includeQuestion: false, diagnostics: {} },
      { user: payer, ip: "8.8.8.8" },
    );
    expect(again.ticketNo).toBe(reportTicket.ticketNo);

    const list = await listTickets({ q: reportTicket.ticketNo });
    expect(list).toHaveLength(1);
    expect(list[0]!.reportVersions).toMatchObject({ prompt: expect.any(String), model: expect.any(String), corpus: expect.any(String) });
    expect(list[0]!.question).toContain("产品岗");
    expect(list[0]!.diagnostics).toMatchObject({ page: `/reports/${reportId}`, appVersion: expect.any(String) });
    const guestRow = (await listTickets({ q: guest.ticketNo }))[0]!;
    expect(guestRow.diagnostics.page).toBe("/unlock/abc"); // 查询参数被去掉
  });

  it("keeps the ticket when the ops notification fails", async () => {
    setEnv({ SUPPORT_NOTIFY_EMAIL: "ops-inbox@example.com" });
    const failing: Mailer = { send: async () => Promise.reject(new Error("mail service down")) };
    __setMailerForTests(failing);
    const t = await submitTicket(
      { idempotencyKey: "notify-fail-1", category: "duplicate_charge_or_refund", reportIssues: [], description: "同一笔扣了两次", includeQuestion: false, diagnostics: {} },
      { user: null, ip: "6.6.6.6" },
    );
    await drainJobs();
    const [row] = await db.select().from(supportTickets).where(eq(supportTickets.ticketNo, t.ticketNo));
    expect(row!.notifiedAt).toBeNull();
    expect((await listTickets({ q: t.ticketNo }))[0]?.status).toBe("open");
    __setMailerForTests({ send: async (m) => void sentMail.push(m) });
    setEnv();
  });

  it("rate-limits guests and keeps the ops list behind the ops allowlist", async () => {
    for (let i = 0; i < 5; i++) {
      await submitTicket({ idempotencyKey: `rl-${i}-xxxxx`, category: "other", reportIssues: [], description: "测试限流用的工单", includeQuestion: false, diagnostics: {} }, { user: null, ip: "5.5.5.5" });
    }
    await expect(
      submitTicket({ idempotencyKey: "rl-6-xxxxx", category: "other", reportIssues: [], description: "测试限流用的工单", includeQuestion: false, diagnostics: {} }, { user: null, ip: "5.5.5.5" }),
    ).rejects.toMatchObject({ status: 429 });

    const normal = await login("normal@example.com");
    expect(() => requireOps(normal)).toThrow();
    expect(() => requireOps(null)).toThrow();
    const ops = await login("ops@example.com");
    expect(requireOps(ops).email).toBe("ops@example.com");
    const [first] = await listTickets({ status: "open" });
    await updateTicketStatus(first!.id, "in_progress");
    expect((await listTickets({ q: first!.ticketNo }))[0]!.status).toBe("in_progress");
  });

  it("lets ops refund a complained-about order through the normal refund flow", async () => {
    const user = await login("complain@example.com");
    const { orderId, reportId } = await boughtAndDelivered(user);
    await requestRefundByOps(orderId, "complaint WS-TEST");
    await drainJobs();
    expect((await getOrderView(user.id, orderId)).status).toBe("refunded");
    expect(await getReportView(user.id, reportId)).toMatchObject({ deleted: true });
  });
});

describe("6 · model routing and cost accounting", () => {
  it("uses terra/low for triage, sol/low for reports, and lets follow-ups inherit or override", async () => {
    expect(routeConfig("triage")).toEqual({ model: "gpt-6.1-terra", effort: "low" });
    expect(routeConfig("report")).toEqual({ model: "gpt-6.2-sol", effort: "low" });
    expect(routeConfig("followup")).toEqual({ model: "gpt-6.2-sol", effort: "low" });

    const user = await login("routes@example.com");
    const { orderId, reportId, readingId } = await boughtAndDelivered(user);
    setEnv({ OPENAI_MODEL_FOLLOWUP: "gpt-6.1-terra", OPENAI_EFFORT_FOLLOWUP: "medium" });
    await submitFollowup(user.id, reportId, "访谈对象从哪里找？", "routes-followup-1");
    await drainJobs();
    setEnv();
    const attempts = await db.select().from(generationAttempts).where(eq(generationAttempts.readingId, readingId));
    const by = (k: string) => attempts.filter((a) => a.kind === k).map((a) => `${a.model}/${a.effort}`);
    expect(by("triage")).toEqual(["fake:gpt-6.1-terra/low"]);
    expect(by("report")).toEqual(["fake:gpt-6.2-sol/low"]);
    expect(by("followup")).toEqual(["fake:gpt-6.1-terra/medium"]);
    expect(attempts.every((a) => a.promptVersion && a.contentVersion)).toBe(true);
    expect((await getOrderView(user.id, orderId)).status).toBe("delivered");
  });

  it("builds Responses API requests with strict JSON schema, store=false and a hashed user id", () => {
    const body = buildResponsesRequest({
      route: "report",
      developer: "d",
      user: "u",
      schemaName: "s",
      jsonSchema: { type: "object" },
      maxOutputTokens: 6000,
      safetyIdentifier: "hash",
      fakeResponse: () => null,
    });
    expect(body).toMatchObject({
      model: "gpt-6.2-sol",
      reasoning: { effort: "low" },
      store: false,
      max_output_tokens: 6000,
      safety_identifier: "hash",
      text: { format: { type: "json_schema", strict: true, name: "s" } },
    });
  });

  it("prices calls from fixed token counts without double-counting reasoning tokens", async () => {
    // sol：10,000 输入（其中 2,000 命中缓存）+ 3,000 输出（含 1,000 推理）
    expect(costUsd("gpt-6.2-sol", { inputTokens: 10_000, cachedTokens: 2_000, outputTokens: 3_000 })).toBeCloseTo(0.0462, 6);
    expect(costUsd("gpt-6.2-sol-2026-10-01", { inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 0 })).toBeCloseTo(2, 6);
    expect(costUsd("fake:gpt-6.2-sol", { inputTokens: null, cachedTokens: null, outputTokens: null })).toBe(0);

    const from = new Date(Date.now() + 10 * 24 * 3600_000);
    const at = new Date(from.getTime() + 1000);
    const row = (kind: string, model: string, input: number, cached: number, output: number, failureReason: string | null = null) => ({
      kind,
      model,
      inputTokens: input,
      cachedTokens: cached,
      outputTokens: output,
      reasoningTokens: Math.floor(output / 3),
      status: failureReason ? "invalid" : "ok",
      failureReason,
      createdAt: at,
    });
    await db.insert(generationAttempts).values([
      row("triage", "gpt-6.1-terra", 2_500, 0, 600), // 未购买用户的分流
      row("triage", "gpt-6.1-terra", 2_500, 0, 600),
      row("report", "gpt-6.2-sol", 8_000, 0, 4_000, "validation"), // 失败重试
      row("report", "gpt-6.2-sol", 8_000, 2_000, 4_000),
    ]);
    const user = await login("cost@example.com");
    const { orderId } = await boughtAndDelivered(user);
    await db.update(orders).set({ deliveredAt: at }).where(eq(orders.id, orderId));

    const s = await costSummary(from, new Date(at.getTime() + 1000));
    const expected =
      2 * ((2_500 * 1 + 600 * 5) / 1e6) + (8_000 * 2 + 4_000 * 10) / 1e6 + (6_000 * 2 + 2_000 * 0.1 + 4_000 * 10) / 1e6;
    expect(s.totalUsd).toBeCloseTo(expected, 8);
    expect(s.deliveredOrders).toBe(1);
    expect(s.costPerDeliveryUsd).toBeCloseTo(expected, 8);
    expect(s.byKind.triage?.calls).toBe(2);
    expect(s.failures.validation).toBe(1);
  });
});
