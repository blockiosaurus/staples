ALTER TABLE "plan_applications" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "plan_applications" ADD COLUMN "superseded_by_id" uuid;