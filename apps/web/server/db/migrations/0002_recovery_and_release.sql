CREATE TABLE "ops_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"order_id" uuid,
	"ticket_id" uuid,
	"result" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider_refund_id" text,
	"status" text DEFAULT 'requested' NOT NULL,
	"amount_minor" integer,
	"currency" text,
	"reason" text NOT NULL,
	"requested_by" text NOT NULL,
	"failure_reason" text,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "generation_attempts" ADD COLUMN "attempt_kind" text DEFAULT 'business' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lock_token" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "confirmation_key" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "ready_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ops_actions_order_idx" ON "ops_actions" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_order_attempt_idx" ON "refunds" USING btree ("order_id","attempt_no");--> statement-breakpoint
CREATE INDEX "refunds_provider_idx" ON "refunds" USING btree ("provider_refund_id");--> statement-breakpoint
CREATE INDEX "refunds_status_idx" ON "refunds" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_pending_confirmation" ON "orders" USING btree ("confirmation_key") WHERE status = 'pending_payment' and confirmation_key is not null;