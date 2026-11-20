import { castFromTosses, tossesFromLines, type LineValue } from "@wenshan/iching-core";
import { __setEnvForTests } from "@/server/env";
import { __setDbForTests, createMemoryDb, type DB } from "@/server/db/client";
import { __setMailerForTests, type MailMessage } from "@/server/mail";
import { __setLlmForTests } from "@/server/llm";
import { __setPaymentProviderForTests } from "@/server/payments";
import { requestOtp, verifyOtp } from "@/server/auth";

export const sentMail: MailMessage[] = [];

/** 每个测试文件一个全新的内存数据库，外部服务全部用本地替身 */
export async function setupTestServer(): Promise<DB> {
  __setEnvForTests({ PGLITE_DIR: "memory", APP_URL: "http://localhost:3000" });
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
