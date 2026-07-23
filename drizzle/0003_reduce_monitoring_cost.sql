UPDATE "monitored_links"
SET
	"is_active" = false,
	"scheduler_locked_until" = NULL,
	"updated_at" = now()
WHERE "environment" = 'dev' AND "is_active" = true;
--> statement-breakpoint
UPDATE "monitored_links"
SET
	"interval_ms" = 1800000,
	"next_check_at" = GREATEST(
		"next_check_at",
		now() + interval '30 minutes'
	),
	"scheduler_locked_until" = NULL,
	"updated_at" = now()
WHERE "environment" = 'prod' AND "interval_ms" < 1800000;
