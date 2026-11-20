CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_no" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"category" text NOT NULL,
	"report_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description_ct" text,
	"contact_email_ct" text,
	"user_id" uuid,
	"order_id" uuid,
	"report_id" uuid,
	"diagnostics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"report_versions" jsonb,
	"question_ct" text,
	"status" text DEFAULT 'open' NOT NULL,
	"ip_hash" text,
	"notified_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_tickets_ticket_no_unique" UNIQUE("ticket_no"),
	CONSTRAINT "support_tickets_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "generation_attempts" ADD COLUMN "reading_id" uuid;--> statement-breakpoint
ALTER TABLE "generation_attempts" ADD COLUMN "effort" text;--> statement-breakpoint
ALTER TABLE "generation_attempts" ADD COLUMN "prompt_version" text;--> statement-breakpoint
ALTER TABLE "generation_attempts" ADD COLUMN "content_version" text;--> statement-breakpoint
ALTER TABLE "generation_attempts" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "reading_revision" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "triage_result_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "intent_ct" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "basis" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "generation_calls" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "refunded_amount_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "review_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "content_purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "readings" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "triage_results" ADD COLUMN "reading_revision" integer;--> statement-breakpoint
CREATE INDEX "tickets_status_idx" ON "support_tickets" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "tickets_ip_idx" ON "support_tickets" USING btree ("ip_hash","created_at");--> statement-breakpoint
CREATE INDEX "orders_reading_idx" ON "orders" USING btree ("reading_id");