CREATE TABLE "monitored_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"convex_url_id" text NOT NULL,
	"convex_user_id" text NOT NULL,
	"long_url" text NOT NULL,
	"short_url" text NOT NULL,
	"interval_ms" integer DEFAULT 60000 NOT NULL,
	"next_check_at" timestamp with time zone NOT NULL,
	"scheduler_locked_until" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"current_status" text DEFAULT 'pending',
	"last_checked_at" timestamp with time zone,
	"last_status_code" integer,
	"last_latency_ms" integer,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_next_check_active" ON "monitored_links" USING btree ("next_check_at","is_active");--> statement-breakpoint
CREATE INDEX "idx_convex_url_id" ON "monitored_links" USING btree ("convex_url_id");--> statement-breakpoint
CREATE INDEX "idx_convex_user_id" ON "monitored_links" USING btree ("convex_user_id");