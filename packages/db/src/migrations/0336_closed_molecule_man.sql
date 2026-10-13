ALTER TABLE "companies" ADD COLUMN "self_serve" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "self_serve_created_by_user_id" text;--> statement-breakpoint
CREATE INDEX "companies_self_serve_creator_idx" ON "companies" USING btree ("self_serve_created_by_user_id");