CREATE TABLE "checkout_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"success_url" text NOT NULL,
	"cancel_url" text NOT NULL,
	"description" text NOT NULL,
	"requested_expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'creating' NOT NULL,
	"provider_session_id" text,
	"checkout_url" text,
	"provider_expires_at" timestamp with time zone,
	"provider_payment_id" text,
	"legacy" boolean DEFAULT false NOT NULL,
	"tries" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_attempts_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
DROP INDEX "refunds_provider_idx";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "refunded_currency" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "paid_amount_minor" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "paid_currency" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "ready_notify_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "provider_payment_id" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "source" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "legacy_request" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "tries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "notify_claimed_at" timestamp with time zone;--> statement-breakpoint
-- 兼容旧数据（手写，非 drizzle-kit 生成）。
-- 1. 迁移前的退款尝试：重放时沿用当时的请求参数；被退款的付款即订单主付款；支付方后台发起的标为外部来源。
UPDATE "refunds" r SET "legacy_request" = true, "provider_payment_id" = o."provider_payment_id",
  "source" = CASE WHEN r."requested_by" = 'provider' THEN 'external' ELSE 'local' END
FROM "orders" o WHERE o."id" = r."order_id";--> statement-breakpoint
-- 2. 同一支付方退款 ID 被记成多条（旧版本按"最近一次进行中的尝试"关联可能造成）：保留最早一条，其余作废并清空 ID。
UPDATE "refunds" r SET "provider_refund_id" = NULL, "status" = 'canceled', "failure_reason" = 'duplicate_provider_refund_id', "updated_at" = now()
WHERE r."provider_refund_id" IS NOT NULL AND EXISTS (
  SELECT 1 FROM "refunds" r2 WHERE r2."provider_refund_id" = r."provider_refund_id" AND (r2."created_at", r2."id") < (r."created_at", r."id")
);--> statement-breakpoint
-- 3. 实际收款：旧版本只在金额、币种与报价一致时才把订单置为已支付（不一致的记 amount_mismatch 待核实），
--    这些订单的实收即报价；amount_mismatch 的旧单实收未知，保持为空，留在运营异常列表里核实。
UPDATE "orders" SET "paid_amount_minor" = "amount_minor", "paid_currency" = lower("currency")
WHERE "paid_at" IS NOT NULL AND "provider_payment_id" IS NOT NULL AND coalesce("review_reason", '') <> 'amount_mismatch';--> statement-breakpoint
UPDATE "orders" SET "refunded_currency" = lower("currency") WHERE "refunded_amount_minor" > 0;--> statement-breakpoint
-- 4. 迁移前的 Checkout：请求参数没有保存，记为 legacy 尝试——只按会话 ID 对账，绝不用旧幂等键重放。
INSERT INTO "checkout_attempts" ("id", "order_id", "attempt_no", "idempotency_key", "amount_minor", "currency", "success_url", "cancel_url", "description",
  "requested_expires_at", "status", "provider_session_id", "checkout_url", "provider_expires_at", "provider_payment_id", "legacy", "created_at", "updated_at")
SELECT gen_random_uuid(), o."id", 1, 'checkout:' || o."id", o."amount_minor", o."currency", '', '', '',
  coalesce(o."checkout_expires_at", o."created_at" + interval '31 minutes'),
  CASE WHEN o."status" IN ('pending_payment', 'expired') THEN 'open' ELSE 'complete' END,
  o."provider_session_id", o."checkout_url", o."checkout_expires_at", o."provider_payment_id", true, o."created_at", now()
FROM "orders" o WHERE o."provider_session_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_attempts" ADD CONSTRAINT "checkout_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_attempts_order_no_idx" ON "checkout_attempts" USING btree ("order_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_attempts_session_idx" ON "checkout_attempts" USING btree ("provider_session_id") WHERE provider_session_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_attempts_one_live_idx" ON "checkout_attempts" USING btree ("order_id") WHERE status in ('creating','open','unknown');--> statement-breakpoint
CREATE INDEX "checkout_attempts_payment_idx" ON "checkout_attempts" USING btree ("provider_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_provider_refund_unique" ON "refunds" USING btree ("provider_refund_id") WHERE provider_refund_id is not null;--> statement-breakpoint
CREATE INDEX "refunds_payment_idx" ON "refunds" USING btree ("provider_payment_id");