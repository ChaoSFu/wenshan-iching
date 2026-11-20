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

function cleanContext(topicId: TopicId, raw: Record<string, string>): Record<string, string> {
  const topic = topicsBundle.topics.find((t) => t.id === topicId)!;
  const allowedKeys = new Set(topic.contextFields.map((f) => f.key));
  return Object.fromEntries(Object.entries(raw).filter(([k, v]) => allowedKeys.has(k) && v));
}

function sameContext(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/**
 * 用户同意发送后，把浏览器里的这一卦上传（PRD §6：付费前由服务端按原始值复算并锁定版本）。
 * 同一用户对同一 clientReadingId 重复上传是幂等的；卦象不可更改。
 * 问题、背景或主题有任何变化，题意修订号 +1，之前的分流结果随之失效，需要重新确认题意。
 */
export async function uploadReading(userId: string, input: UploadReadingInput): Promise<{ readingId: string; revision: number }> {
  let cast: Cast;
  try {
    cast = castFromTosses(input.tosses);
  } catch (err) {
    if (err instanceof CastValidationError) throw new HttpError(400, "invalid_tosses", err.message);
    throw err;
  }
  const context = cleanContext(input.topicId, input.context);

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
    const unchanged =
      existing.questionCt !== null &&
      existing.topicId === input.topicId &&
      decrypt(existing.questionCt) === input.question &&
      sameContext(existing.contextCt ? decryptJson<Record<string, string>>(existing.contextCt) : {}, context);
    const [row] = await db
      .update(readings)
      .set(
        unchanged
          ? { modelConsentAt: new Date() }
          : {
              topicId: input.topicId,
              questionCt: encrypt(input.question),
              contextCt: encryptJson(context),
              revision: sql`${readings.revision} + 1`,
              modelConsentAt: new Date(),
              updatedAt: sql`now()`,
              deletedAt: null,
            },
      )
      .where(eq(readings.id, existing.id))
      .returning({ revision: readings.revision });
    return { readingId: existing.id, revision: row!.revision };
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
    .returning({ id: readings.id, revision: readings.revision });
  return { readingId: row!.id, revision: row!.revision };
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
  revision: number;
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
    revision: r.revision,
    updatedAt: r.updatedAt,
  };
}

/** 纠正主题：复用同一组爻值（PRD §4），但题意修订号 +1，需要重新确认题意 */
export async function changeTopic(userId: string, readingId: string, topicId: TopicId): Promise<{ revision: number }> {
  const reading = await loadOwnedReading(userId, readingId);
  if (reading.topicId === topicId) return { revision: reading.revision };
  const db = await getDb();
  const [row] = await db
    .update(readings)
    .set({
      topicId,
      contextCt: encryptJson(cleanContext(topicId, reading.context)),
      revision: sql`${readings.revision} + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(readings.id, readingId))
    .returning({ revision: readings.revision });
  return { revision: row!.revision };
}

/** 用户确认采用建议的改写：问题更新为改写后的问法，修订号 +1，需要重新分流 */
export async function adoptReframe(userId: string, readingId: string, question: string): Promise<{ revision: number }> {
  const text = z.string().trim().min(4).max(200).parse(question);
  await loadOwnedReading(userId, readingId);
  const db = await getDb();
  const [row] = await db
    .update(readings)
    .set({ questionCt: encrypt(text), revision: sql`${readings.revision} + 1`, updatedAt: sql`now()` })
    .where(eq(readings.id, readingId))
    .returning({ revision: readings.revision });
  return { revision: row!.revision };
}
