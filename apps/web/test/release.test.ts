/**
 * 第二轮 P0-4：模拟模式只连测试库、关闭收款的生产模式按能力运行、求助号码按审核状态展示、发布验收。
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { visibleHelp, type HelpResources } from "@wenshan/content";
import { CapabilityUnavailableError, capabilityGaps } from "@/server/capabilities";
import { topicsBundle } from "@/server/content";
import { getDb } from "@/server/db/client";
import { jobs, orders, supportTickets } from "@/server/db/schema";
import { __resetEnvCache, __setEnvForTests, parseEnv, type Env } from "@/server/env";
import { drainJobs } from "@/server/jobs/runner";
import { getLlm, __setLlmForTests } from "@/server/llm";
import { __setMailerForTests } from "@/server/mail";
import { getOffer } from "@/server/offer";
import { createOrderForReading, handlePaymentEvent } from "@/server/orders";
import { getPaymentProvider, __setPaymentProviderForTests } from "@/server/payments";
import { completeFakeCheckout } from "@/server/payments/fake";
import { uploadReading } from "@/server/readings";
import { releaseStatus } from "@/server/release";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { submitTicket } from "@/server/support";
import { runTriage } from "@/server/triage";
import { confirmation, login, sentMail, setupTestServer, tossesFor } from "./helpers";

const KEY = Buffer.alloc(32, 9).toString("base64");
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 看起来像真实服务的占位值：模拟模式下一个都不能被用到 */
const INHERITED = {
  DATABASE_URL: "postgres://prod-user:secret@db.example.invalid:5432/wenshan",
  STRIPE_SECRET_KEY: "sk_live_placeholder",
  STRIPE_WEBHOOK_SECRET: "whsec_placeholder",
  OPENAI_API_KEY: "sk-placeholder",
  RESEND_API_KEY: "re_placeholder",
};

describe("P0-4 · simulation mode only ever touches a test database", () => {
  it("ignores an inherited DATABASE_URL and real-looking keys, and uses the test PGlite directory", () => {
    const e = parseEnv({ NODE_ENV: "development", RUN_MODE: "simulation", ...INHERITED });
    expect(e.DATABASE_URL).toBeUndefined();
    expect(e.PGLITE_DIR).toBe(".data/pglite-test");
    expect([e.PAYMENT_PROVIDER, e.LLM_PROVIDER, e.MAIL_PROVIDER]).toEqual(["fake", "fake", "console"]);
    expect([e.STRIPE_SECRET_KEY, e.OPENAI_API_KEY, e.RESEND_API_KEY]).toEqual([undefined, undefined, undefined]);
  });

  it("accepts only a PostgreSQL test database through SIMULATION_DATABASE_URL", () => {
    expect(() => parseEnv({ RUN_MODE: "simulation", SIMULATION_DATABASE_URL: "postgres://localhost/wenshan" })).toThrow(/测试库/);
    const e = parseEnv({ RUN_MODE: "simulation", ...INHERITED, SIMULATION_DATABASE_URL: "postgres://localhost:5432/wenshan_test" });
    expect(e.DATABASE_URL).toBe("postgres://localhost:5432/wenshan_test");
  });

  it("refuses a non-test PGlite directory before opening any connection", async () => {
    const dir = path.join(tmpdir(), `wenshan-real-${process.pid}-${Date.now()}`);
    const saved = { ...process.env };
    const g = globalThis as unknown as { __wenshanDb?: unknown };
    const savedDb = g.__wenshanDb;
    try {
      Object.assign(process.env, { NODE_ENV: "development", RUN_MODE: "simulation", PGLITE_DIR: dir, ...INHERITED });
      __resetEnvCache();
      g.__wenshanDb = undefined;
      await expect(getDb()).rejects.toThrow(/PGLITE_DIR 必须是测试目录/);
      expect(existsSync(dir)).toBe(false);
    } finally {
      process.env = saved;
      g.__wenshanDb = savedDb;
      __resetEnvCache();
    }
  });

  it("SIMULATION_LLM=openai opens only the model: payment stays simulated, mail stays local, other keys and DATABASE_URL are still dropped", () => {
    const e = parseEnv({ NODE_ENV: "development", RUN_MODE: "simulation", SIMULATION_LLM: "openai", ALLOW_UNREVIEWED_CONTENT: "true", ...INHERITED });
    expect([e.PAYMENT_PROVIDER, e.LLM_PROVIDER, e.MAIL_PROVIDER]).toEqual(["fake", "openai", "console"]);
    expect(e.OPENAI_API_KEY).toBe(INHERITED.OPENAI_API_KEY);
    expect([e.STRIPE_SECRET_KEY, e.STRIPE_WEBHOOK_SECRET, e.RESEND_API_KEY, e.DATABASE_URL]).toEqual([undefined, undefined, undefined, undefined]);
    expect(e.PGLITE_DIR).toBe(".data/pglite-test");
    // 未审内容只配模拟支付：报价不要求审核
    expect(capabilityGaps(e).llm).toEqual([]);
    expect(() => parseEnv({ RUN_MODE: "simulation", SIMULATION_LLM: "openai" })).toThrow(/OPENAI_API_KEY/);
    expect(() => parseEnv({ NODE_ENV: "production", RUN_MODE: "simulation", SIMULATION_LLM: "openai", ...INHERITED })).toThrow(/生产环境/);
  });

  it("is forbidden in production, and unreviewed content requires simulation mode", () => {
    expect(() => parseEnv({ NODE_ENV: "production", RUN_MODE: "simulation" })).toThrow(/生产环境/);
    expect(() => parseEnv({ ALLOW_UNREVIEWED_CONTENT: "true" })).toThrow(/模拟模式/);
    expect(parseEnv({ RUN_MODE: "simulation", ALLOW_UNREVIEWED_CONTENT: "true" }).ALLOW_UNREVIEWED_CONTENT).toBe(true);
  });
});

/** 关闭收款的生产环境：只有数据库与加密密钥，没有 Stripe、OpenAI、Resend */
const FREE_PROD: Partial<Env> = {
  NODE_ENV: "production",
  SALES_ENABLED: false,
  ALLOW_UNREVIEWED_CONTENT: false,
  DATABASE_URL: "postgres://configured-but-replaced-by-test-db/wenshan",
  DATA_ENCRYPTION_KEY: KEY,
  PAYMENT_PROVIDER: "fake",
  LLM_PROVIDER: "fake",
  MAIL_PROVIDER: "console",
  SUPPORT_NOTIFY_EMAIL: "ops@example.com",
};

describe("P0-4 · production with sales closed runs without payment or model credentials", () => {
  beforeAll(async () => {
    await setupTestServer();
  });
  afterEach(() => {
    __setLlmForTests(null);
    __setPaymentProviderForTests(null);
    __setMailerForTests({ send: async (m) => void sentMail.push(m) });
  });

  it("starts, serves the offer as closed, and validates sales config only when sales are on", () => {
    const base = { NODE_ENV: "production", DATABASE_URL: "postgres://h/wenshan", DATA_ENCRYPTION_KEY: KEY };
    const e = parseEnv(base);
    const gaps = capabilityGaps(e);
    expect(gaps.database).toEqual([]);
    expect(gaps.payments.length && gaps.llm.length && gaps.mail.length).toBeTruthy();
    expect(() => parseEnv({ ...base, SALES_ENABLED: "true" })).toThrow(/SALES_ENABLED=true: .*PAYMENT_PROVIDER=stripe.*LLM_PROVIDER=openai/);
  });

  it("never falls back to fake payments, fake reports or console mail", () => {
    __setEnvForTests(FREE_PROD);
    __setLlmForTests(null);
    __setPaymentProviderForTests(null);
    __setMailerForTests(null);
    expect(getOffer().salesEnabled).toBe(false);
    expect(() => getPaymentProvider()).toThrow(CapabilityUnavailableError);
    expect(() => getLlm()).toThrow(CapabilityUnavailableError);
  });

  it("accepts support tickets; the notification waits for mail config without burning retries", async () => {
    __setEnvForTests(FREE_PROD);
    __setMailerForTests(null);
    const t = await submitTicket(
      { idempotencyKey: "free-prod-ticket-1", category: "other", reportIssues: [], description: "页面打不开了，帮忙看看", includeQuestion: false, diagnostics: {} },
      { user: null, ip: "203.0.113.9" },
    );
    expect(t.ticketNo).toMatch(/^WS-/);
    await drainJobs();
    const db = await getDb();
    const [job] = await db.select().from(jobs).where(eq(jobs.kind, "notify_support_ticket"));
    expect(job!.status).toBe("queued");
    expect(job!.attempts).toBe(0);
    expect(job!.lastError).toMatch(/mail unavailable: MAIL_PROVIDER=resend/);
    const [row] = await db.select().from(supportTickets).where(eq(supportTickets.ticketNo, t.ticketNo));
    expect(row!.notifiedAt).toBeNull();
  });

  it("rejects new orders while sales are closed", async () => {
    __setEnvForTests({ ...FREE_PROD, NODE_ENV: "test" });
    const user = await login("closed@example.com");
    const { readingId } = await uploadReading(user.id, {
      clientReadingId: "closed-1",
      question: "要不要换工作？",
      topicId: "career",
      topicOriginal: "career",
      context: {},
      tosses: tossesFor([7, 7, 7, 8, 8, 8]),
      consent: true,
    });
    await expect(createOrderForReading(user, await confirmation(readingId))).rejects.toMatchObject({ code: "sales_closed" });
  });

  it("an already-paid order waits for model config instead of failing or refunding, then completes", async () => {
    await setupTestServer();
    const user = await login("paid-before-close@example.com");
    const { readingId } = await uploadReading(user.id, {
      clientReadingId: "paid-before-close",
      question: "下个月要不要提出调岗？",
      topicId: "career",
      topicOriginal: "career",
      context: {},
      tosses: tossesFor([9, 7, 8, 7, 7, 8]),
      consent: true,
    });
    await runTriage(user.id, readingId);
    const { orderId } = await createOrderForReading(user, await confirmation(readingId));
    const db = await getDb();
    const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
    const { body, signature } = completeFakeCheckout(o!.providerSessionId!);
    await handlePaymentEvent(getPaymentProvider().parseWebhook(body, new Headers({ "x-fake-signature": signature })));

    // 收款关闭后模型凭据被撤下：报告任务延后，订单仍是已付款，不占用调用次数，也不触发退款
    __setEnvForTests(FREE_PROD);
    __setLlmForTests(null);
    await drainJobs();
    const [waiting] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(waiting!.status).toBe("paid");
    expect(waiting!.generationCalls).toBe(0);
    const [job] = await db.select().from(jobs).where(eq(jobs.kind, "generate_report"));
    expect(job!.status).toBe("queued");
    expect(job!.attempts).toBe(0);

    // 配置恢复后照常履约
    await setupTestServerKeepingDb();
    await db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.id, job!.id));
    await drainJobs();
    const [done] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(done!.status).toBe("delivered");
    expect(done!.generationCalls).toBe(1);
  });
});

/** 恢复测试配置但保留当前数据库 */
async function setupTestServerKeepingDb() {
  __setEnvForTests({ PGLITE_DIR: "memory", APP_URL: "http://localhost:3000", SALES_ENABLED: true, ALLOW_UNREVIEWED_CONTENT: true });
  __setLlmForTests(null);
  __setPaymentProviderForTests(null);
  __setMailerForTests({ send: async (m) => void sentMail.push(m) });
}

describe("P0-4 · help resources follow their review status", () => {
  const help: HelpResources = {
    version: 2,
    intro: "如有危险请联系当地紧急服务。",
    regions: [
      { id: "a", name: "甲地", items: [{ label: "急救", number: "111", reviewStatus: "reviewed", source: "https://example.org", verifiedAt: "2026-11-01" }] },
      { id: "b", name: "乙地", items: [{ label: "热线", number: "222", reviewStatus: "draft" }] },
      { id: "c", name: "其他地区", items: [{ label: "请拨打当地的紧急电话", reviewStatus: "draft" }] },
    ],
  };

  it("hides unverified numbers on public pages, keeps numberless guidance", () => {
    const v = visibleHelp(help, { includeUnverified: false });
    expect(v.regions.map((r) => r.id)).toEqual(["a", "c"]);
    expect(v.hidden).toBe(1);
  });

  it("shows and marks unverified numbers in development", () => {
    const v = visibleHelp(help, { includeUnverified: true });
    expect(v.regions.find((r) => r.id === "b")!.items[0]).toMatchObject({ number: "222", unverified: true });
  });

  it("the shipped help file currently has no verified numbers, so production shows only the generic guidance", () => {
    const v = visibleHelp(topicsBundle.help, { includeUnverified: false });
    expect(v.regions.flatMap((r) => r.items).every((i) => !i.number)).toBe(true);
    expect(v.regions.length).toBeGreaterThan(0);
  });
});

describe("release check: three results (config, content review, live acceptance) for two targets", () => {
  const prodFree = () =>
    parseEnv({ NODE_ENV: "production", DATABASE_URL: "postgres://h/wenshan", DATA_ENCRYPTION_KEY: KEY, OPS_EMAILS: "ops@example.com", SUPPORT_EMAIL: "help@example.com" });
  const clean = { basicErrors: [], strictErrors: [], stale: [] };

  it("free release is ready with a database, an ops entry and a public support address; sales are blocked with reasons", () => {
    const s = releaseStatus(prodFree(), { sources: { basicErrors: [], strictErrors: ["original not reviewed: 1.gua"], stale: [] } });
    expect(s.freeReady).toBe(true);
    expect(s.salesReady).toBe(false);
    const salesBlockers = s.checks.filter((c) => c.sales === "fail").map((c) => c.id);
    expect(salesBlockers).toEqual(
      expect.arrayContaining(["content.review", "content.help", "content.strict", "capability.payments", "capability.llm", "capability.mail", "sales.switch", "live.stripe", "live.openai", "live.resend"]),
    );
    expect(s.checks.find((c) => c.id === "content.review")!.free).toBe("warn");
    expect(s.checks.find((c) => c.id === "capability.payments")!.free).toBe("na");
    expect(s.sections).toMatchObject({ config: { free: "warn", sales: "fail" }, content: { free: "warn", sales: "fail" }, live: { sales: "fail" } });
  });

  it("free release separately requires the ops entry and the public support address", () => {
    const e = parseEnv({ NODE_ENV: "production", DATABASE_URL: "postgres://h/wenshan", DATA_ENCRYPTION_KEY: KEY });
    const s = releaseStatus(e, { sources: clean });
    expect(s.freeReady).toBe(false);
    expect(s.checks.filter((c) => c.free === "fail").map((c) => c.id).sort()).toEqual(["ops", "support.email"]);
  });

  it("a production config without a database cannot even ship the free experience", () => {
    const s = releaseStatus(parseEnv({ NODE_ENV: "production" }));
    expect(s.freeReady).toBe(false);
    expect(s.checks.find((c) => c.id === "capability.database")!.free).toBe("fail");
  });

  it("generated files out of sync with the sources block both targets; without source checks the panel says to run the CLI", () => {
    const stale = releaseStatus(prodFree(), { sources: { ...clean, stale: ["generated/corpus.json"] } });
    expect(stale.checks.find((c) => c.id === "content.consistency")).toMatchObject({ free: "fail", sales: "fail" });
    const panel = releaseStatus(prodFree());
    expect(panel.checks.find((c) => c.id === "content.consistency")).toMatchObject({ free: "warn", sales: "fail" });
    expect(panel.checks.find((c) => c.id === "content.consistency")!.detail).toContain("npm run release:check");
  });

  it("live acceptance counts only passing records with nothing pending, on a clean commit, for the current config version", async () => {
    const { configVersion } = await import("@/server/acceptance");
    const e = prodFree();
    const ev = (service: "stripe" | "openai" | "resend", over: Record<string, unknown> = {}) => ({
      service,
      recordedAt: "2026-11-21T10:00:00Z",
      commit: "abcdef1234567890",
      dirty: false,
      configVersion: configVersion(e, service),
      environment: "test mode",
      result: "pass" as const,
      checks: [{ name: "x", ok: true, detail: "" }],
      pending: [],
      ...over,
    });
    const s = releaseStatus(e, {
      sources: clean,
      evidence: [
        ev("stripe"),
        ev("openai", { pending: ["人工评审贴合度"] }),
        ev("resend", { configVersion: "000000000000" }),
        // 更早的一条失败记录被最近的通过记录取代
        ev("stripe", { recordedAt: "2026-11-20T10:00:00Z", result: "fail" }),
      ],
    });
    const live = Object.fromEntries(s.checks.filter((c) => c.section === "live").map((c) => [c.id, c]));
    expect(live["live.stripe"]!.sales).toBe("pass");
    expect(live["live.openai"]).toMatchObject({ sales: "fail" });
    expect(live["live.openai"]!.detail).toContain("待核实");
    expect(live["live.resend"]!.detail).toContain("配置已改动");
    expect(live["live.stripe"]!.free).toBe("na");
  });

  it("the CLI rejects an unknown target or flag instead of guessing", () => {
    const run = (...args: string[]) => spawnSync("npx", ["tsx", "scripts/release-check.ts", ...args], { cwd: WEB_DIR, encoding: "utf8" });
    const bad = run("--target=prod");
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("--target 只能是 free 或 sales");
    expect(run("--targte=sales").status).toBe(2);
  }, 60_000);
});
