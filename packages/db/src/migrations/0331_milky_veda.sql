CREATE TABLE "company_user_ui_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"pinned" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hidden" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revealed" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seen" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"show_everything" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_user_ui_preferences" ADD CONSTRAINT "company_user_ui_preferences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_user_ui_preferences_company_idx" ON "company_user_ui_preferences" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "company_user_ui_preferences_user_idx" ON "company_user_ui_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_user_ui_preferences_company_user_uq" ON "company_user_ui_preferences" USING btree ("company_id","user_id");