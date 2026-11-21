import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { requestOtp, verifyOtp } from "@/server/auth";
import { decrypt, encrypt } from "@/server/crypto";
import type { DB } from "@/server/db/client";
import { orders, readings, reports } from "@/server/db/schema";
import { drainJobs, runMaintenance } from "@/server/jobs/runner";
import { __setLlmForTests, getLlm, type LlmProvider } from "@/server/llm";
import { createOrderForReading, getOrderView, handlePaymentEvent } from "@/server/orders";
import { getPaymentProvider } from "@/server/payments";
import { completeFakeCheckout } from "@/server/payments/fake";
import { uploadReading } from "@/server/readings";
import { deleteReport, getReportView, submitFollowup } from "@/server/report/service";
import { runTriage } from "@/server/triage";
import { __setEnvForTests } from "@/server/env";
import { login, sentMail, setupTestServer, tossesFor , confirmation } from "./helpers";

let db: DB;
beforeAll(async () => {
  db = await setupTestServer();
});

let seq = 0;
async function preparedReading(user: { id: string }, question = "我做后端，想转产品岗，接下来四周怎么试？") {
  const { readingId } = await uploadReading(user.id, {
    clientReadingId: `client-${++seq}-xxxxxxxx`,
    question,
    topicId: "career",
    topicOriginal: "career",
    context: { options: "留在现岗位；内部转产品岗" },
    tosses: tossesFor([9, 7, 7, 7, 7, 7]),
    consent: true,
  });
  return readingId;
}

async function pay(orderId: string) {
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  const { body, signature } = completeFakeCheckout(o!.providerSessionId!);
  const event = getPaymentProvider().parseWebhook(body, new Headers({ "x-fake-signature": signature }));
  return { event, result: await handlePaymentEvent(event) };
}

describe("crypto", () => {
  it("round-trips and detects tampering", () => {
    const ct = encrypt("你好，问山");
    expect(decrypt(ct)).toBe("你好，问山");
    const parts = ct.split(":");
    parts[4] = parts[4]!.slice(0, -2) + (parts[4]!.endsWith("A") ? "BB" : "AA");
    expect(() => decrypt(parts.join(":"))).toThrow();
  });
});

describe("email OTP login", () => {
  it("logs in with the emailed code and rejects wrong codes", async () => {
    await requestOtp("Test@Example.com", "1.1.1.1");
    const mail = sentMail.at(-1)!;
    expect(mail.to).toBe("test@example.com");
    const code = mail.subject.match(/(\d{6})/)![1]!;
    await expect(verifyOtp("test@example.com", code === "000000" ? "111111" : "000000")).rejects.toThrow();
    const ok = await verifyOtp("test@example.com", code);
    expect(ok.token.length).toBeGreaterThan(20);
    // 验证码只能用一次
    await expect(verifyOtp("test@example.com", code)).rejects.toThrow();
  });

  it("rate-limits requests per email", async () => {
    for (let i = 0; i < 5; i++) await requestOtp("limit@example.com", `10.0.0.${i}`);
    await expect(requestOtp("limit@example.com", "10.0.0.9")).rejects.toMatchObject({ status: 429 });
  });
});

describe("paid flow (fake payment + fake model)", () => {
  it("goes from upload → triage → checkout → webhook → report → follow-ups → delete", async () => {
    const user = await login("buyer@example.com");
    const readingId = await preparedReading(user);

    // 没确认题意不能下单
    await expect(createOrderForReading(user, await confirmation(readingId))).rejects.toMatchObject({ code: "triage_required" });
    const triage = await runTriage(user.id, readingId);
    expect(triage.decision).toBe("proceed");

    const { orderId, checkoutUrl } = await createOrderForReading(user, await confirmation(readingId));
    expect(checkoutUrl).toContain("/dev/checkout/");
    // 重复下单复用同一个未完成的结账
    expect((await createOrderForReading(user, await confirmation(readingId))).orderId).toBe(orderId);

    const { event, result } = await pay(orderId);
    expect(result).toBe("processed");
    // 回调重放不会重复发货
    expect(await handlePaymentEvent(event)).toBe("duplicate");
    expect((await getOrderView(user.id, orderId)).status).toBe("paid");

    await drainJobs();
    const view = await getOrderView(user.id, orderId);
    expect(view.status).toBe("delivered");
    expect(view.reportId).toBeTruthy();
    expect(sentMail.some((m) => m.to === user.email && m.subject.includes("报告已生成"))).toBe(true);

    const report = await getReportView(user.id, view.reportId!);
    if ("deleted" in report) throw new Error("report unexpectedly deleted");
    expect(report.cast.primaryName).toBe("乾");
    expect(report.content.observations.length).toBeGreaterThan(0);
    for (const o of report.content.observations) for (const c of o.citations) expect(report.citations[c]).toBeTruthy();

    // 问题与报告在库里是密文
    const [r] = await db.select().from(readings).where(eq(readings.id, readingId));
    expect(r!.questionCt).not.toContain("产品岗");
    const [rep] = await db.select().from(reports).where(eq(reports.id, view.reportId!));
    expect(rep!.contentCt).not.toContain("产品");

    // 别人看不到
    const other = await login("other@example.com");
    await expect(getReportView(other.id, view.reportId!)).rejects.toMatchObject({ status: 404 });
    await expect(getOrderView(other.id, orderId)).rejects.toMatchObject({ status: 404 });

    // 追问：同一个幂等键只算一次；"另一件事"不扣次数；三次用完后拒绝
    const a = await submitFollowup(user.id, view.reportId!, "我没有正式的产品项目，可以拿哪种后端项目当案例？", "key-aaaaaaaa");
    const again = await submitFollowup(user.id, view.reportId!, "我没有正式的产品项目，可以拿哪种后端项目当案例？", "key-aaaaaaaa");
    expect(again).toEqual(a);
    await submitFollowup(user.id, view.reportId!, "顺便问一下另外一件事：要不要搬家？", "key-bbbbbbbb");
    await drainJobs();
    let after = await getReportView(user.id, view.reportId!);
    if ("deleted" in after) throw new Error("deleted");
    expect(after.followups.map((f) => f.status)).toEqual(["done", "rejected"]);
    expect(after.followupsRemaining).toBe(2);
    await submitFollowup(user.id, view.reportId!, "第二个追问：案例要写多长？", "key-cccccccc");
    await submitFollowup(user.id, view.reportId!, "第三个追问：访谈该问什么？", "key-dddddddd");
    await expect(submitFollowup(user.id, view.reportId!, "第四个追问", "key-eeeeeeee")).rejects.toMatchObject({ code: "no_followups_left" });
    await drainJobs();
    after = await getReportView(user.id, view.reportId!);
    if ("deleted" in after) throw new Error("deleted");
    expect(after.followupsRemaining).toBe(0);

    // 追问里出现危险信号时暂停，不扣次数
    const crisis = await submitFollowup(user.id, view.reportId!, "我真的不想活了", "key-ffffffff");
    expect(crisis.status).toBe("crisis");

    // 删除后内容清空，订单账务保留
    await deleteReport(user.id, view.reportId!);
    expect(await getReportView(user.id, view.reportId!)).toMatchObject({ deleted: true });
    const [rep2] = await db.select().from(reports).where(eq(reports.id, view.reportId!));
    expect(rep2!.contentCt).toBeNull();
    const [r2] = await db.select().from(readings).where(eq(readings.id, readingId));
    expect(r2!.questionCt).toBeNull();
    expect((await getOrderView(user.id, orderId)).amountMinor).toBe(990);
  });

  it("refunds a second payment for the same reading automatically", async () => {
    const user = await login("twice@example.com");
    const readingId = await preparedReading(user);
    await runTriage(user.id, readingId);
    const first = await createOrderForReading(user, await confirmation(readingId));
    // 第一个结账页还开着，另一个标签页在报价版本更新后重新确认，开了第二笔订单
    const env = { PGLITE_DIR: "memory", APP_URL: "http://localhost:3000", SALES_ENABLED: true, ALLOW_UNREVIEWED_CONTENT: true, PRICE_AMOUNT_MINOR: 990 };
    __setEnvForTests({ ...env, PRICE_VERSION: "price@second-tab" });
    const second = await createOrderForReading(user, await confirmation(readingId));
    __setEnvForTests(env);
    expect(second.orderId).not.toBe(first.orderId);

    await pay(first.orderId);
    await pay(second.orderId);
    expect((await getOrderView(user.id, second.orderId)).status).toBe("refund_pending");
    await drainJobs();
    expect((await getOrderView(user.id, first.orderId)).status).toBe("delivered");
    expect((await getOrderView(user.id, second.orderId)).status).toBe("refunded");
  });

  it("moves an order with a mismatched amount to needs_review instead of delivering", async () => {
    const user = await login("mismatch@example.com");
    const readingId = await preparedReading(user);
    await runTriage(user.id, readingId);
    const { orderId } = await createOrderForReading(user, await confirmation(readingId));
    await db.update(orders).set({ amountMinor: 1990 }).where(eq(orders.id, orderId));
    await pay(orderId);
    const v = await getOrderView(user.id, orderId);
    expect(v.status).toBe("needs_review");
    expect(v.reviewReason).toBe("amount_mismatch");
    await drainJobs();
    expect((await getOrderView(user.id, orderId)).status).toBe("needs_review");
  });
});

describe("generation failures", () => {
  function stubLlm(data: unknown, kind: "ok" | "refusal" = "ok"): void {
    const base = getLlm();
    const stub: LlmProvider = {
      name: "fake",
      moderate: base.moderate,
      generateStructured: async (req) => {
        const meta = { model: "stub", effort: "none", latencyMs: 1, usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, reasoningTokens: 0 } };
        if (req.route === "triage") return { kind: "ok", data: req.fakeResponse(), ...meta };
        return kind === "refusal" ? { kind: "refusal", message: "no", ...meta } : { kind: "ok", data, ...meta };
      },
    };
    __setLlmForTests(stub);
  }

  it("marks the order as failed after one retry, then refunds when the promise period passes", async () => {
    const user = await login("fail@example.com");
    const readingId = await preparedReading(user);
    await runTriage(user.id, readingId);
    stubLlm({ question_summary: "x" }); // 不合 schema
    const { orderId } = await createOrderForReading(user, await confirmation(readingId));
    await pay(orderId);
    await drainJobs();
    expect((await getOrderView(user.id, orderId)).status).toBe("generation_failed");

    __setLlmForTests(null);
    await db.update(orders).set({ refundDueAt: new Date(Date.now() - 1000) }).where(eq(orders.id, orderId));
    await runMaintenance();
    await drainJobs();
    const v = await getOrderView(user.id, orderId);
    expect(v.status).toBe("refunded");
    expect(v.failureReason).toBe("validation_failed");
  });

  it("retries a failed generation in the background before the refund deadline", async () => {
    const user = await login("retry@example.com");
    const readingId = await preparedReading(user);
    await runTriage(user.id, readingId);
    stubLlm({ question_summary: "x" });
    const { orderId } = await createOrderForReading(user, await confirmation(readingId));
    await pay(orderId);
    await drainJobs();
    expect((await getOrderView(user.id, orderId)).status).toBe("generation_failed");

    // 15 分钟后维护任务重新生成；这次模型恢复正常
    __setLlmForTests(null);
    await db.update(orders).set({ updatedAt: new Date(Date.now() - 20 * 60_000) }).where(eq(orders.id, orderId));
    await runMaintenance();
    await drainJobs();
    expect((await getOrderView(user.id, orderId)).status).toBe("delivered");
  });

  it("refunds immediately when the model refuses", async () => {
    const user = await login("refusal@example.com");
    const readingId = await preparedReading(user);
    await runTriage(user.id, readingId);
    stubLlm(null, "refusal");
    const { orderId } = await createOrderForReading(user, await confirmation(readingId));
    await pay(orderId);
    await drainJobs();
    __setLlmForTests(null);
    expect((await getOrderView(user.id, orderId)).status).toBe("refunded");
  });
});

describe("pre-purchase triage", () => {
  it("routes immediate-harm wording to crisis and blocks health questions from purchase", async () => {
    const user = await login("triage@example.com");
    const crisis = await runTriage(user.id, await preparedReading(user, "最近活不下去了，工作还要不要继续？"));
    expect(crisis.decision).toBe("crisis");

    const healthId = await preparedReading(user, "我确诊了，手术后还能回去上班吗？");
    const health = await runTriage(user.id, healthId);
    expect(health.decision).toBe("block_paid");
    await expect(createOrderForReading(user, await confirmation(healthId))).rejects.toMatchObject({ code: "not_purchasable" });
  });

  it("keeps the cast locked once uploaded", async () => {
    const user = await login("locked@example.com");
    const base = {
      clientReadingId: "locked-reading-1",
      question: "要不要接这个项目？",
      topicId: "career" as const,
      topicOriginal: "career" as const,
      context: {},
      consent: true as const,
    };
    await uploadReading(user.id, { ...base, tosses: tossesFor([7, 7, 7, 7, 7, 7]) });
    await expect(uploadReading(user.id, { ...base, tosses: tossesFor([8, 8, 8, 8, 8, 8]) })).rejects.toMatchObject({
      code: "cast_immutable",
    });
  });
});
