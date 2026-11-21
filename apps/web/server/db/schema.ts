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
    /** 题意修订号：问题、背景或主题每改一次 +1；分流结果与订单快照都绑定到某个修订 */
    revision: integer("revision").notNull().default(1),
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
    /** 分流针对的题意修订；旧数据为空，视为无效 */
    readingRevision: integer("reading_revision"),
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
  /** 金额或币种异常、旧订单无法还原题意等，需要运营核实 */
  "needs_review",
  /** 支付方确认退款失败，等待运营核实后重试 */
  "refund_failed",
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
    /** 下单时冻结的题意修订与所用分流结果 */
    readingRevision: integer("reading_revision"),
    triageResultId: uuid("triage_result_id"),
    /** 冻结的个人内容（密文）：问题、背景、题意摘要、待补信息 */
    intentCt: text("intent_ct"),
    /** 冻结的非个人依据：主题版本、卦象、获准引用的原文与版本、分流决定 */
    basis: jsonb("basis"),
    /** 这笔订单已经发起的模型调用次数（含后台重试），受上限约束 */
    generationCalls: integer("generation_calls").notNull().default(0),
    refundedAmountMinor: integer("refunded_amount_minor").notNull().default(0),
    reviewReason: text("review_reason"),
    contentPurgedAt: timestamp("content_purged_at", { withTimezone: true }),
    /** 用户确认的题意修订、分流结果与报价的摘要；同一确认只对应一个待支付尝试 */
    confirmationKey: text("confirmation_key"),
    /** 交付通知邮件已认领发送（防止租约接管后重复发信） */
    readyNotifiedAt: timestamp("ready_notified_at", { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index("orders_user_idx").on(t.userId, t.createdAt),
    index("orders_reading_idx").on(t.readingId),
    index("orders_session_idx").on(t.providerSessionId),
    index("orders_payment_idx").on(t.providerPaymentId),
    // 同一次起卦只能有一笔有效付款；第二笔会被识别为重复支付并自动退款（技术方案 5.9）
    uniqueIndex("orders_one_paid_per_reading")
      .on(t.readingId)
      .where(sql`status in ('paid','generating','delivered','generation_failed')`),
    // 同一次确认（修订 + 分流 + 报价）只允许一个待支付尝试：并发点击、网络重试都复用它
    uniqueIndex("orders_pending_confirmation")
      .on(t.confirmationKey)
      .where(sql`status = 'pending_payment' and confirmation_key is not null`),
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
  /** 分流调用没有订单，用 readingId 关联（未购买用户的分流也计入成本） */
  readingId: uuid("reading_id"),
  kind: text("kind").notNull(),
  model: text("model").notNull(),
  effort: text("effort"),
  /** business：一次业务调用（含校验重试中的每一次）；transport：同一业务调用里网络或限流导致的重发 */
  attemptKind: text("attempt_kind").notNull().default("business"),
  promptVersion: text("prompt_version"),
  contentVersion: text("content_version"),
  failureReason: text("failure_reason"),
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
    /** 每次认领生成新的标识；续租、完成、失败都要带上它，租约被接管后旧执行者的更新无效 */
    lockToken: uuid("lock_token"),
    dedupeKey: text("dedupe_key").unique(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index("jobs_ready_idx").on(t.status, t.runAt)],
);

export const TICKET_CATEGORIES = [
  "duplicate_charge_or_refund",
  "paid_not_delivered",
  "login_or_page_error",
  "report_content",
  "other",
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export const TICKET_STATUSES = ["open", "in_progress", "resolved"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** 用户反馈工单（/support）。描述、联系邮箱、问卦原文以密文保存 */
export const supportTickets = pgTable(
  "support_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketNo: text("ticket_no").notNull().unique(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    category: text("category").$type<TicketCategory>().notNull(),
    reportIssues: jsonb("report_issues").notNull().default([]),
    descriptionCt: text("description_ct"),
    contactEmailCt: text("contact_email_ct"),
    userId: uuid("user_id"),
    orderId: uuid("order_id"),
    reportId: uuid("report_id"),
    /** 页面、错误编号、应用版本等有限诊断信息 */
    diagnostics: jsonb("diagnostics").notNull().default({}),
    /** 报告工单：模型、Prompt 与内容版本 */
    reportVersions: jsonb("report_versions"),
    /** 用户主动选择附上的问卦原文（密文） */
    questionCt: text("question_ct"),
    status: text("status").$type<TicketStatus>().notNull().default("open"),
    ipHash: text("ip_hash"),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** 超过保留期后清除描述、联系邮箱与原文的时间 */
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index("tickets_status_idx").on(t.status, t.createdAt), index("tickets_ip_idx").on(t.ipHash, t.createdAt)],
);

export const REFUND_STATUSES = ["requested", "pending", "succeeded", "failed", "canceled"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/**
 * 退款尝试：同一次尝试的自动重试复用同一个支付方幂等键；
 * 支付方确认失败后，只有运营核实上一笔结果才能开新尝试（attempt_no + 1，新幂等键）。
 */
export const refunds = pgTable(
  "refunds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    attemptNo: integer("attempt_no").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    providerRefundId: text("provider_refund_id"),
    status: text("status").$type<RefundStatus>().notNull().default("requested"),
    /** 支付方确认的本次退款金额与币种（未确认前为空） */
    amountMinor: integer("amount_minor"),
    currency: text("currency"),
    reason: text("reason").notNull(),
    requestedBy: text("requested_by").notNull(),
    failureReason: text("failure_reason"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex("refunds_order_attempt_idx").on(t.orderId, t.attemptNo),
    index("refunds_provider_idx").on(t.providerRefundId),
    index("refunds_status_idx").on(t.status, t.updatedAt),
  ],
);

/** 运营的人工操作记录：谁、何时、对哪笔订单或工单做了什么、结果如何 */
export const opsActions = pgTable(
  "ops_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    orderId: uuid("order_id"),
    ticketId: uuid("ticket_id"),
    result: text("result").notNull(),
    note: text("note"),
    createdAt: created(),
  },
  (t) => [index("ops_actions_order_idx").on(t.orderId, t.createdAt)],
);
