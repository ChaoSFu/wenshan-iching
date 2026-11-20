import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * 数据模型（技术方案第 6 节）。名为 *_ct 的列是应用层加密后的密文（server/crypto.ts）。
 * 邮箱只在 users 表；问题与报告内容只以密文存在 readings / reports / followups 等表。
 */

const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updated = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  createdAt: created(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

export const authOtps = pgTable(
  "auth_otps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    emailHash: text("email_hash").notNull(),
    ipHash: text("ip_hash"),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [index("auth_otps_email_idx").on(t.emailHash, t.createdAt), index("auth_otps_ip_idx").on(t.ipHash, t.createdAt)],
);

export const sessions = pgTable("sessions", {
  /** sha256(会话令牌)；令牌本身只在 cookie 里 */
  id: text("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: created(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const readings = pgTable(
  "readings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientReadingId: text("client_reading_id").notNull(),
    topicId: text("topic_id").notNull(),
    topicOriginal: text("topic_original").notNull(),
    questionCt: text("question_ct"),
    contextCt: text("context_ct"),
    /** 原始掷币结果；卦象字段由服务端复算，写入后不再修改 */
    tosses: jsonb("tosses").notNull(),
    lines: jsonb("lines").notNull(),
    primaryHex: integer("primary_hex").notNull(),
    changedHex: integer("changed_hex"),
    movingLines: jsonb("moving_lines").notNull(),
    castVersion: text("cast_version").notNull(),
    selectionVersion: text("selection_version").notNull(),
    corpusVersion: text("corpus_version").notNull(),
    topicsVersion: text("topics_version").notNull(),
    modelConsentAt: timestamp("model_consent_at", { withTimezone: true }).notNull(),
    createdAt: created(),
    updatedAt: updated(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("readings_user_client_idx").on(t.userId, t.clientReadingId)],
);

export const triageResults = pgTable(
  "triage_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    readingId: uuid("reading_id")
      .notNull()
      .references(() => readings.id, { onDelete: "cascade" }),
    decision: text("decision").notNull(),
    riskCategory: text("risk_category").notNull(),
    confirmedTopic: text("confirmed_topic"),
    outputCt: text("output_ct"),
    moderationFlagged: boolean("moderation_flagged").notNull().default(false),
    triageVersion: text("triage_version").notNull(),
    model: text("model").notNull(),
    createdAt: created(),
  },
  (t) => [index("triage_reading_idx").on(t.readingId, t.createdAt)],
);

export const ORDER_STATUSES = [
  "pending_payment",
  "expired",
  "paid",
  "generating",
  "delivered",
  "generation_failed",
  "refund_pending",
  "refunded",
  "disputed",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    readingId: uuid("reading_id")
      .notNull()
      .references(() => readings.id),
    status: text("status").$type<OrderStatus>().notNull().default("pending_payment"),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    priceVersion: text("price_version").notNull(),
    provider: text("provider").notNull(),
    providerSessionId: text("provider_session_id"),
    providerPaymentId: text("provider_payment_id"),
    checkoutUrl: text("checkout_url"),
    checkoutExpiresAt: timestamp("checkout_expires_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    refundDueAt: timestamp("refund_due_at", { withTimezone: true }),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    followupsTotal: integer("followups_total").notNull().default(3),
    followupsUsed: integer("followups_used").notNull().default(0),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index("orders_user_idx").on(t.userId, t.createdAt),
    index("orders_session_idx").on(t.providerSessionId),
    index("orders_payment_idx").on(t.providerPaymentId),
    // 同一次起卦只能有一笔有效付款；第二笔会被识别为重复支付并自动退款（技术方案 5.9）
    uniqueIndex("orders_one_paid_per_reading")
      .on(t.readingId)
      .where(sql`status in ('paid','generating','delivered','generation_failed')`),
  ],
);

export const paymentEvents = pgTable("payment_events", {
  eventId: text("event_id").primaryKey(),
  provider: text("provider").notNull(),
  type: text("type").notNull(),
  orderId: uuid("order_id"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  note: text("note"),
});

export const reports = pgTable("reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id")
    .notNull()
    .unique()
    .references(() => orders.id),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  readingId: uuid("reading_id")
    .notNull()
    .references(() => readings.id),
  contentCt: text("content_ct"),
  /** 引用的原文编号（不含正文） */
  citations: jsonb("citations").notNull(),
  /** 引用原文的快照（密文），旧报告即使内容版本更新也能按当时的依据显示 */
  citationsSnapshotCt: text("citations_snapshot_ct"),
  versions: jsonb("versions").notNull(),
  attempts: integer("attempts").notNull().default(1),
  latencyMs: integer("latency_ms"),
  createdAt: created(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deleteReason: text("delete_reason"),
});

export const followups = pgTable(
  "followups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    seq: integer("seq").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    questionCt: text("question_ct"),
    answerCt: text("answer_ct"),
    /** queued / done / rejected（不是同一件事，不扣次数）/ failed（不扣次数） */
    status: text("status").notNull().default("queued"),
    versions: jsonb("versions"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("followups_idem_idx").on(t.orderId, t.idempotencyKey)],
);

export const generationAttempts = pgTable("generation_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id"),
  kind: text("kind").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens"),
  cachedTokens: integer("cached_tokens"),
  outputTokens: integer("output_tokens"),
  reasoningTokens: integer("reasoning_tokens"),
  latencyMs: integer("latency_ms"),
  status: text("status").notNull(),
  refused: boolean("refused").notNull().default(false),
  validatorErrors: jsonb("validator_errors"),
  createdAt: created(),
});

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("queued"),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lastError: text("last_error"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    dedupeKey: text("dedupe_key").unique(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index("jobs_ready_idx").on(t.status, t.runAt)],
);
