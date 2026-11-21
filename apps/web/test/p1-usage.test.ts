/**
 * 第二轮 P1：线上履约的用量记录区分业务调用、传输层重发与输出内容审核失败。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DB } from "@/server/db/client";
import { generationAttempts, jobs, orders } from "@/server/db/schema";
import { drainJobs } from "@/server/jobs/runner";
import { LlmTransientError, __setLlmForTests, getLlm, type LlmProvider } from "@/server/llm";
import { costSummary } from "@/server/llm/usage";
import { createOrderForReading, handlePaymentEvent } from "@/server/orders";
import { getPaymentProvider } from "@/server/payments";
import { completeFakeCheckout } from "@/server/payments/fake";
import { uploadReading } from "@/server/readings";
import { runTriage } from "@/server/triage";
import { confirmation, login, setupTestServer, tossesFor } from "./helpers";

let db: DB;
beforeAll(async () => {
  db = await setupTestServer();
});

let n = 0;
async function paidOrder(email: string) {
  const user = await login(email);
  const { readingId } = await uploadReading(user.id, {
    clientReadingId: `p1-${++n}-xxxxxxxx`,
    question: "要不要接下这个外包项目？",
    topicId: "career",
    topicOriginal: "career",
    context: {},
    tosses: tossesFor([9, 7, 7, 7, 7, 7]),
    consent: true,
  });
  await runTriage(user.id, readingId);
  const { orderId } = await createOrderForReading(user, await confirmation(readingId));
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  const { body, signature } = completeFakeCheckout(o!.providerSessionId!);
  await handlePaymentEvent(getPaymentProvider().parseWebhook(body, new Headers({ "x-fake-signature": signature })));
  return orderId;
}

describe("P1 · usage records in the paid fulfilment path", () => {
  it("records output-moderation failures as their own status, not as validation errors", async () => {
    __setLlmForTests(null);
    const fake = getLlm();
    const orderId = await paidOrder("moderated@example.com");
    __setLlmForTests({ ...fake, moderate: async () => ({ flagged: true, categories: ["harassment"] }) });
    await drainJobs();
    const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(o!.status).toBe("generation_failed");
    const rows = await db.select().from(generationAttempts).where(eq(generationAttempts.orderId, orderId));
    expect(rows.map((r) => [r.status, r.failureReason, r.attemptKind])).toEqual([
      ["moderation_flagged", "moderation", "business"],
      ["moderation_flagged", "moderation", "business"],
    ]);
    expect(rows[0]!.validatorErrors).toEqual(["harassment"]);
    __setLlmForTests(null);
  });

  it("records each failed send as a transport attempt; the business call is counted once", async () => {
    __setLlmForTests(null);
    const fake = getLlm();
    const orderId = await paidOrder("flaky@example.com");
    let sends = 0;
    const flaky: LlmProvider = {
      ...fake,
      async generateStructured(req) {
        sends++;
        if (sends === 1) throw new LlmTransientError("503", [{ error: "503", latencyMs: 10 }, { error: "connection", latencyMs: 10 }]);
        const res = await fake.generateStructured(req);
        return { ...res, transportFailures: [{ error: "429", latencyMs: 10 }] };
      },
    };
    __setLlmForTests(flaky);
    await drainJobs(); // 第一次：两次发送都失败 → 任务按临时故障退避重试
    const [job] = await db.select().from(jobs).where(and(eq(jobs.kind, "generate_report"), eq(jobs.status, "queued")));
    expect(job!.payload).toEqual({ orderId });
    await db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.id, job!.id));
    await drainJobs(); // 第二次：一次 429 后重发成功
    const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(o!.status).toBe("delivered");
    const rows = await db.select().from(generationAttempts).where(eq(generationAttempts.orderId, orderId));
    const transport = rows.filter((r) => r.attemptKind === "transport").map((r) => r.failureReason).sort();
    expect(transport).toEqual(["request_error:429", "request_error:503", "request_error:connection"]);
    expect(rows.filter((r) => r.attemptKind === "business").map((r) => r.status)).toEqual(["ok"]);

    const s = await costSummary(new Date(Date.now() - 3600_000), new Date(Date.now() + 1000));
    expect(s.transportFailures).toBeGreaterThanOrEqual(3);
    // 替身调用没有用量：成本未知，不计 0
    expect(s.unknownCostCalls).toBe(s.calls);
    __setLlmForTests(null);
  });
});
