import { randomInt } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { keyedHash, randomToken, safeEqual, sha256 } from "./crypto";
import { getDb } from "./db/client";
import { authOtps, sessions, users } from "./db/schema";
import { env } from "./env";
import { HttpError } from "./http";
import { getMailer } from "./mail";

/**
 * 邮箱验证码登录（技术方案 5.10）。用 6 位验证码而不是魔法链接：
 * 手机上从邮件 App 打开链接常会跳到另一个浏览器，丢掉当前标签页里的免费结果。
 */

export const SESSION_COOKIE = "ws_session";
const OTP_TTL_MS = 10 * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 30 * 24 * 3600_000;
const LIMIT_PER_EMAIL_PER_HOUR = 5;
const LIMIT_PER_IP_PER_HOUR = 20;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: "请输入有效的邮箱地址" }).max(254));

export async function requestOtp(rawEmail: string, ip: string): Promise<void> {
  const email = emailSchema.parse(rawEmail);
  const db = await getDb();
  const emailHash = keyedHash("email", email);
  const ipHash = keyedHash("ip", ip);
  const hourAgo = new Date(Date.now() - 3600_000);

  const [byEmail] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(authOtps)
    .where(and(eq(authOtps.emailHash, emailHash), gt(authOtps.createdAt, hourAgo)));
  const [byIp] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(authOtps)
    .where(and(eq(authOtps.ipHash, ipHash), gt(authOtps.createdAt, hourAgo)));
  if ((byEmail?.n ?? 0) >= LIMIT_PER_EMAIL_PER_HOUR || (byIp?.n ?? 0) >= LIMIT_PER_IP_PER_HOUR) {
    throw new HttpError(429, "too_many_requests", "请求太频繁，请稍后再试");
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.insert(authOtps).values({
    emailHash,
    ipHash,
    codeHash: keyedHash("otp", `${emailHash}:${code}`),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });
  await getMailer().send({
    to: email,
    subject: `问山登录验证码：${code}`,
    text: `你的问山登录验证码是 ${code}，10 分钟内有效。\n如果不是你本人操作，请忽略这封邮件。`,
  });
}

export async function verifyOtp(rawEmail: string, code: string): Promise<{ token: string; userId: string }> {
  const email = emailSchema.parse(rawEmail);
  const db = await getDb();
  const emailHash = keyedHash("email", email);
  const [otp] = await db
    .select()
    .from(authOtps)
    .where(and(eq(authOtps.emailHash, emailHash), isNull(authOtps.consumedAt), gt(authOtps.expiresAt, new Date())))
    .orderBy(desc(authOtps.createdAt))
    .limit(1);
  if (!otp || otp.attempts >= OTP_MAX_ATTEMPTS) throw new HttpError(400, "otp_invalid", "验证码无效或已过期，请重新获取");

  const ok = /^\d{6}$/.test(code) && safeEqual(otp.codeHash, keyedHash("otp", `${emailHash}:${code}`));
  if (!ok) {
    await db.update(authOtps).set({ attempts: otp.attempts + 1 }).where(eq(authOtps.id, otp.id));
    throw new HttpError(400, "otp_invalid", "验证码不正确");
  }

  return db.transaction(async (tx) => {
    const consumed = await tx
      .update(authOtps)
      .set({ consumedAt: new Date() })
      .where(and(eq(authOtps.id, otp.id), isNull(authOtps.consumedAt)))
      .returning({ id: authOtps.id });
    if (consumed.length === 0) throw new HttpError(400, "otp_invalid", "验证码已使用，请重新获取");

    const [user] = await tx
      .insert(users)
      .values({ email, lastLoginAt: new Date() })
      .onConflictDoUpdate({ target: users.email, set: { lastLoginAt: new Date() } })
      .returning({ id: users.id });
    const token = randomToken();
    await tx.insert(sessions).values({ id: sha256(token), userId: user!.id, expiresAt: new Date(Date.now() + SESSION_TTL_MS) });
    return { token, userId: user!.id };
  });
}

export interface SessionUser {
  id: string;
  email: string;
}

export async function userFromToken(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const db = await getDb();
  const [row] = await db
    .select({ id: users.id, email: users.email })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

export async function deleteSession(token: string): Promise<void> {
  const db = await getDb();
  await db.delete(sessions).where(eq(sessions.id, sha256(token)));
}

export function sessionCookie(token: string) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: env().NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  };
}
