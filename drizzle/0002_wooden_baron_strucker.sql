DROP INDEX "idx_convex_url_id";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_convex_url_id" ON "monitored_links" USING btree ("convex_url_id");