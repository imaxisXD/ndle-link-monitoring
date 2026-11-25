ALTER TABLE "monitored_links" ALTER COLUMN "environment" SET DEFAULT 'prod';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_convex_user_id";
--> statement-breakpoint
CREATE INDEX "idx_monitored_links_due" ON "monitored_links" ("environment", "next_check_at") WHERE "is_active" = true AND "is_deleted" = false;
--> statement-breakpoint
CREATE INDEX "idx_monitor_checks_delivered" ON "monitor_checks" ("link_id", "measured_at" DESC) WHERE "finished_at" IS NOT NULL AND "failed_at" IS NULL AND "last_error" IS NULL;
--> statement-breakpoint
CREATE INDEX "idx_monitor_checks_pending" ON "monitor_checks" ("next_attempt_at") WHERE "finished_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "idx_monitor_checks_finished" ON "monitor_checks" ("finished_at") WHERE "finished_at" IS NOT NULL;
