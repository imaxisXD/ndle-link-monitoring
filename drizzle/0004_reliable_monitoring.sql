ALTER TABLE "monitored_links" ADD COLUMN "monitoring_version" bigint DEFAULT 0 NOT NULL;
ALTER TABLE "monitored_links" ADD COLUMN "is_deleted" boolean DEFAULT false NOT NULL;
DROP INDEX "idx_convex_url_id";
CREATE UNIQUE INDEX "idx_environment_convex_url_id" ON "monitored_links" ("environment", "convex_url_id");
ALTER TABLE "monitored_links" ALTER COLUMN "interval_ms" SET DEFAULT 1800000;
CREATE TABLE "monitor_checks" (
  "id" text PRIMARY KEY NOT NULL,
  "link_id" uuid NOT NULL REFERENCES "monitored_links"("id"),
  "monitoring_version" bigint NOT NULL,
  "source" text NOT NULL,
  "scheduled_at" timestamp with time zone NOT NULL,
  "measured_at" timestamp with time zone,
  "result" jsonb,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "queue_lease_until" timestamp with time zone,
  "measurement_lease_until" timestamp with time zone,
  "delivery_attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "finished_at" timestamp with time zone
);
CREATE INDEX "idx_monitor_checks_due" ON "monitor_checks" ("finished_at", "next_attempt_at");
CREATE INDEX "idx_monitor_checks_link" ON "monitor_checks" ("link_id");
