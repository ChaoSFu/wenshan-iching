import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { CastValidationError, SELECTION_RULE_VERSION, castFromTosses, type Cast } from "@wenshan/iching-core";
import { TOPIC_IDS, type TopicId } from "@wenshan/content";
import { corpus, topicsBundle } from "./content";
import { decrypt, decryptJson, encrypt, encryptJson } from "./crypto";
import { getDb } from "./db/client";
import { readings } from "./db/schema";
import { HttpError } from "./http";

export const uploadReadingSchema = z.object({
  clientReadingId: z.string().min(8).max(64),
  question: z.string().trim().min(4).max(200),
  topicId: z.enum(TOPIC_IDS as [TopicId, ...TopicId[]]),
  topicOriginal: z.enum(TOPIC_IDS as [TopicId, ...TopicId[]]),
  context: z.record(z.string(), z.string().trim().max(120)).default({}),
  tosses: z.unknown(),
  consent: z.literal(true),
});
export type UploadReadingInput = z.infer<typeof uploadReadingSchema>;

/**
 * 用户同意发送后，把浏览器里的这一卦上传（PRD §6：付费前由服务端按原始值复算并锁定版本）。
 * 同一用户对同一 clientReadingId 重复上传是幂等的；卦象不可更改，问题与主题可以更新。
 */
export async function uploadReading(userId: string, input: UploadReadingInput): Promise<{ readingId: string }> {
  let cast: Cast;
  try {
    cast = castFromTosses(input.tosses);
  } catch (err) {
    if (err instanceof CastValidationError) throw new HttpError(400, "invalid_tosses", err.message);
    throw err;
  }
  const topic = topicsBundle.topics.find((t) => t.id === input.topicId)!;
  const allowedKeys = new Set(topic.contextFields.map((f) => f.key));
  const context = Object.fromEntries(Object.entries(input.context).filter(([k, v]) => allowedKeys.has(k) && v));

  const db = await getDb();
  const [existing] = await db
    .select()
    .from(readings)
    .where(and(eq(readings.userId, userId), eq(readings.clientReadingId, input.clientReadingId)))
    .limit(1);

  if (existing) {
    if (JSON.stringify(existing.tosses) !== JSON.stringify(cast.tosses)) {
      throw new HttpError(409, "cast_immutable", "这一卦已经锁定，不能更换爻值");
    }
    await db
      .update(readings)
      .set({
        topicId: input.topicId,
        questionCt: encrypt(input.question),
        contextCt: encryptJson(context),
        modelConsentAt: new Date(),
        updatedAt: sql`now()`,
        deletedAt: null,
      })
      .where(eq(readings.id, existing.id));
    return { readingId: existing.id };
  }

  const [row] = await db
    .insert(readings)
    .values({
      userId,
      clientReadingId: input.clientReadingId,
      topicId: input.topicId,
      topicOriginal: input.topicOriginal,
      questionCt: encrypt(input.question),
      contextCt: encryptJson(context),
      tosses: cast.tosses,
      lines: cast.lines,
      primaryHex: cast.primary,
      changedHex: cast.changed,
      movingLines: cast.movingLines,
      castVersion: cast.ruleVersion,
      selectionVersion: SELECTION_RULE_VERSION,
      corpusVersion: corpus.version,
      topicsVersion: topicsBundle.version,
      modelConsentAt: new Date(),
    })
    .returning({ id: readings.id });
  return { readingId: row!.id };
}

export interface ReadingPlain {
  id: string;
  /** 浏览器里的起卦 id，用于回到免费结果页 /r/[clientReadingId] */
  clientReadingId: string;
  userId: string;
  topicId: TopicId;
  topicOriginal: TopicId;
  question: string;
  context: Record<string, string>;
  cast: Cast;
  corpusVersion: string;
  updatedAt: Date;
}

export async function loadOwnedReading(userId: string, readingId: string): Promise<ReadingPlain> {
  const db = await getDb();
  const [r] = await db
    .select()
    .from(readings)
    .where(and(eq(readings.id, readingId), eq(readings.userId, userId), isNull(readings.deletedAt)))
    .limit(1);
  // 不属于当前用户时与不存在一样返回 404
  if (!r || !r.questionCt) throw new HttpError(404, "not_found");
  return toPlain(r);
}

export function toPlain(r: typeof readings.$inferSelect): ReadingPlain {
  return {
    id: r.id,
    clientReadingId: r.clientReadingId,
    userId: r.userId,
    topicId: r.topicId as TopicId,
    topicOriginal: r.topicOriginal as TopicId,
    question: r.questionCt ? decrypt(r.questionCt) : "",
    context: r.contextCt ? decryptJson<Record<string, string>>(r.contextCt) : {},
    cast: castFromTosses(r.tosses),
    corpusVersion: r.corpusVersion,
    updatedAt: r.updatedAt,
  };
}

export async function changeTopic(userId: string, readingId: string, topicId: TopicId): Promise<void> {
  await loadOwnedReading(userId, readingId);
  const db = await getDb();
  // 纠正主题时复用同一组爻值（PRD §4）
  await db.update(readings).set({ topicId, updatedAt: sql`now()` }).where(eq(readings.id, readingId));
}
