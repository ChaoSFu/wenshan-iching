import { castFromTosses, tossesFromLines, type LineValue } from "@wenshan/iching-core";
import { __setEnvForTests, type Env } from "@/server/env";
import { __setDbForTests, createMemoryDb, type DB } from "@/server/db/client";
import { __setMailerForTests, type MailMessage } from "@/server/mail";
import { __setLlmForTests } from "@/server/llm";
import { __setPaymentProviderForTests } from "@/server/payments";
import { requestOtp, verifyOtp } from "@/server/auth";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { readings, triageResults } from "@/server/db/schema";
import { getOffer } from "@/server/offer";
import { TRIAGE_VERSION } from "@/server/triage";

export const sentMail: MailMessage[] = [];

/** 每个测试文件一个全新的内存数据库，外部服务全部用本地替身 */
export async function setupTestServer(overrides: Partial<Env> = {}): Promise<DB> {
  __setEnvForTests({
    PGLITE_DIR: "memory",
    APP_URL: "http://localhost:3000",
    // 测试配置：开放收款，并允许模拟支付使用未审核内容（仓库里的初稿保持真实审核状态）
    SALES_ENABLED: true,
    ALLOW_UNREVIEWED_CONTENT: true,
    ...overrides,
  });
  __setMailerForTests({ send: async (m) => void sentMail.push(m) });
  __setLlmForTests(null);
  __setPaymentProviderForTests(null);
  const db = await createMemoryDb();
  __setDbForTests(db);
  return db;
}

export async function login(email: string): Promise<{ id: string; email: string }> {
  await requestOtp(email, "127.0.0.1");
  const mail = sentMail.filter((m) => m.to === email).at(-1)!;
  const code = mail.subject.match(/(\d{6})/)![1]!;
  const { userId } = await verifyOtp(email, code);
  return { id: userId, email };
}

export function tossesFor(lines: LineValue[]) {
  return castFromTosses(tossesFromLines(lines)).tosses;
}

/**
 * 模拟解锁页提交的确认：当前题意修订、当前修订下最新的分流结果、当前报价版本。
 * 不主动分流——没有分流结果时用一个占位 id，服务端会按"需要先确认题意"拒绝。
 */
export async function confirmation(readingId: string, overrides: Partial<{ readingRevision: number; triageId: string; priceVersion: string }> = {}) {
  const db = await getDb();
  const [r] = await db.select({ revision: readings.revision }).from(readings).where(eq(readings.id, readingId));
  const [t] = await db
    .select({ id: triageResults.id })
    .from(triageResults)
    .where(and(eq(triageResults.readingId, readingId), eq(triageResults.readingRevision, r!.revision), eq(triageResults.triageVersion, TRIAGE_VERSION)))
    .orderBy(desc(triageResults.createdAt))
    .limit(1);
  return {
    readingId,
    readingRevision: r!.revision,
    triageId: t?.id ?? "00000000-0000-4000-8000-000000000000",
    priceVersion: getOffer().priceVersion,
    ...overrides,
  };
}
