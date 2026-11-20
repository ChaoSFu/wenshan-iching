import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { runLocalTriage } from "@wenshan/content";
import { lineLabel } from "@wenshan/iching-core";
import { corpus, topicsBundle } from "../content";
import { decrypt, decryptJson, encrypt } from "../crypto";
import { getDb } from "../db/client";
import { followups, orders, readings, reports, users } from "../db/schema";
import { env } from "../env";
import { HttpError } from "../http";
import { enqueue } from "../jobs/queue";
import { getMailer } from "../mail";
import { purgeOrderContent } from "../orders";
import { toPlain } from "../readings";
import type { FollowupContent, ReportContent } from "./schema";

export interface ReportView {
  id: string;
  orderId: string;
  createdAt: string;
  expiresAt: string;
  topicName: string;
  question: string;
  cast: { primaryName: string; changedName: string | null; moving: string[]; primary: number; changed: number | null; lines: number[] };
  content: ReportContent;
  citations: Record<string, { title: string; text: string; sourceUrl: string | null }>;
  followups: { id: string; seq: number; status: string; question: string; answer: FollowupContent | null }[];
  followupsRemaining: number;
  versions: Record<string, string>;
}

async function ownedReport(userId: string, reportId: string) {
  const db = await getDb();
  const [row] = await db
    .select({ report: reports, order: orders, reading: readings })
    .from(reports)
    .innerJoin(orders, eq(orders.id, reports.orderId))
    .innerJoin(readings, eq(readings.id, reports.readingId))
    .where(and(eq(reports.id, reportId), eq(reports.userId, userId)))
    .limit(1);
  if (!row) throw new HttpError(404, "not_found");
  return row;
}

/** 报告页数据：只有本人、已交付、未删除、未过期的报告可看（PRD §8） */
export async function getReportView(userId: string, reportId: string): Promise<ReportView | { deleted: true; reason: string | null }> {
  const { report, order, reading } = await ownedReport(userId, reportId);
  if (report.deletedAt || !report.contentCt || order.status !== "delivered" || !reading.questionCt) {
    return { deleted: true, reason: report.deleteReason ?? order.status };
  }
  if (report.expiresAt.getTime() < Date.now()) return { deleted: true, reason: "expired" };

  const db = await getDb();
  const plain = toPlain(reading);
  const snapshot = report.citationsSnapshotCt ? decryptJson<{ id: string; title: string; text: string }[]>(report.citationsSnapshotCt) : [];
  const citations: ReportView["citations"] = {};
  for (const s of snapshot) {
    const e = corpus.entries[s.id];
    citations[s.id] = {
      title: s.title,
      text: s.text,
      sourceUrl: e ? (corpus.hexagrams[String(e.hexagram)]?.sourcePermalink ?? null) : null,
    };
  }
  const fus = await db.select().from(followups).where(eq(followups.orderId, order.id)).orderBy(asc(followups.seq));
  const topic = topicsBundle.topics.find((t) => t.id === plain.topicId);
  const yang = (pos: number) => plain.cast.lines[pos - 1] === 7 || plain.cast.lines[pos - 1] === 9;
  return {
    id: report.id,
    orderId: order.id,
    createdAt: report.createdAt.toISOString(),
    expiresAt: report.expiresAt.toISOString(),
    topicName: topic?.name ?? plain.topicId,
    question: plain.question,
    cast: {
      primary: plain.cast.primary,
      changed: plain.cast.changed,
      lines: plain.cast.lines,
      primaryName: corpus.hexagrams[String(plain.cast.primary)]?.name ?? "",
      changedName: plain.cast.changed ? (corpus.hexagrams[String(plain.cast.changed)]?.name ?? null) : null,
      moving: plain.cast.movingLines.map((p) => lineLabel(p, yang(p))),
    },
    content: decryptJson<ReportContent>(report.contentCt),
    citations,
    followups: fus
      .filter((f) => f.questionCt)
      .map((f) => ({
        id: f.id,
        seq: f.seq,
        status: f.status,
        question: decrypt(f.questionCt!),
        answer: f.answerCt ? decryptJson<FollowupContent>(f.answerCt) : null,
      })),
    followupsRemaining: Math.max(0, order.followupsTotal - order.followupsUsed),
    versions: report.versions as Record<string, string>,
  };
}

/** 用户随时删除：清除问题、报告与追问内容，保留订单的账务字段（PRD §8） */
export async function deleteReport(userId: string, reportId: string): Promise<void> {
  const { order } = await ownedReport(userId, reportId);
  const db = await getDb();
  await db.transaction((tx) => purgeOrderContent(tx, order.id, "user_deleted"));
}

export type FollowupSubmitResult =
  | { status: "queued"; followupId: string }
  | { status: "crisis"; message: string };

export async function submitFollowup(userId: string, reportId: string, question: string, idempotencyKey: string): Promise<FollowupSubmitResult> {
  const { report, order } = await ownedReport(userId, reportId);
  if (report.deletedAt || order.status !== "delivered" || report.expiresAt.getTime() < Date.now()) {
    throw new HttpError(409, "report_unavailable", "这份报告已不可追问");
  }
  const local = runLocalTriage(question, topicsBundle.triage);
  if (local.crisis) return { status: "crisis", message: local.notices[0]?.message ?? "" };

  const db = await getDb();
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: followups.id })
      .from(followups)
      .where(and(eq(followups.orderId, order.id), eq(followups.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (existing) return { status: "queued" as const, followupId: existing.id };

    // 先占用一次次数：条件更新保证并发提交也不会超过三次
    const [reserved] = await tx
      .update(orders)
      .set({ followupsUsed: sql`${orders.followupsUsed} + 1`, updatedAt: new Date() })
      .where(and(eq(orders.id, order.id), lt(orders.followupsUsed, orders.followupsTotal)))
      .returning({ used: orders.followupsUsed });
    if (!reserved) throw new HttpError(409, "no_followups_left", "三次追问已经用完");

    const [f] = await tx
      .insert(followups)
      .values({ orderId: order.id, seq: reserved.used, idempotencyKey, questionCt: encrypt(question) })
      .returning({ id: followups.id });
    await enqueue(tx, "generate_followup", { followupId: f!.id });
    return { status: "queued" as const, followupId: f!.id };
  });
}

/** 报告到期（默认交付后 90 天）自动清除内容 */
export async function purgeExpiredReports(): Promise<number> {
  const db = await getDb();
  const expired = await db
    .select({ orderId: reports.orderId })
    .from(reports)
    .where(and(isNull(reports.deletedAt), lt(reports.expiresAt, new Date())))
    .limit(200);
  for (const { orderId } of expired) {
    await db.transaction((tx) => purgeOrderContent(tx, orderId, "expired"));
  }
  return expired.length;
}

/** 交付通知邮件：只含链接，不含问题与报告内容 */
export async function sendReportReadyEmail(orderId: string): Promise<void> {
  const db = await getDb();
  const [row] = await db
    .select({ email: users.email, status: orders.status })
    .from(orders)
    .innerJoin(users, eq(users.id, orders.userId))
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!row || row.status !== "delivered") return;
  await getMailer().send({
    to: row.email,
    subject: "你的问山报告已生成",
    text: `你的报告已经生成，可以随时回来查看：\n${env().APP_URL}/orders/${orderId}\n\n报告保留 ${env().REPORT_RETENTION_DAYS} 天，到期前可以导出，也可以随时删除。`,
  });
}
