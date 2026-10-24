-- M18: site personas, multi-site distribution, scheduled publishing.
CREATE TABLE site_persona (
 site_id text PRIMARY KEY REFERENCES site(id), data jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid REFERENCES operator_user(id)
);
-- The version of the last human-reviewed content revision; GitHub stats bumps leave it alone.
ALTER TABLE resource ADD COLUMN content_version integer NOT NULL DEFAULT 0;
UPDATE resource r SET content_version=coalesce((SELECT max(version) FROM resource_revision WHERE resource_id=r.id),0);
-- Operational pin only: never changes canonical or hreflang.
ALTER TABLE resource ADD COLUMN primary_site_id text REFERENCES site(id);
ALTER TABLE ai_job DROP CONSTRAINT ai_job_kind_check;
ALTER TABLE ai_job ADD CONSTRAINT ai_job_kind_check CHECK(kind IN ('generate','translate','seo','enrich','compare','distribute'));
ALTER TABLE ai_prompt DROP CONSTRAINT ai_prompt_kind_check;
ALTER TABLE ai_prompt ADD CONSTRAINT ai_prompt_kind_check CHECK(kind IN ('generate','translate','seo','enrich','compare','distribute'));
-- Tokens held for a queued distribution job; counted against the budget until it finishes.
ALTER TABLE ai_job ADD COLUMN reserved_tokens integer NOT NULL DEFAULT 0;
CREATE TABLE distribution (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), resource_id text NOT NULL REFERENCES resource(id),
 created_by uuid REFERENCES operator_user(id), mode text NOT NULL CHECK(mode IN ('ai','manual')),
 stagger_days integer NOT NULL DEFAULT 0 CHECK(stagger_days BETWEEN 0 AND 30),
 replace_drafts boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX distribution_resource ON distribution(resource_id,created_at DESC);
CREATE TABLE distribution_task (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 distribution_id uuid NOT NULL REFERENCES distribution(id) ON DELETE CASCADE,
 site_id text NOT NULL REFERENCES site(id), locale text NOT NULL CHECK(locale IN ('zh','en')),
 state text NOT NULL CHECK(state IN ('queued','generating','awaiting_input','review','scheduled','published','failed','skipped','cancelled')),
 ai_job_id uuid REFERENCES ai_job(id) ON DELETE SET NULL, draft_version integer,
 persona jsonb NOT NULL, persona_version integer NOT NULL DEFAULT 0,
 source_version integer NOT NULL, prompt_version text NOT NULL DEFAULT 'v1',
 output jsonb, reasons text[] NOT NULL DEFAULT '{}', similarity real, content_hash text,
 publish_at timestamptz, error text, attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(distribution_id,site_id,locale)
);
CREATE INDEX distribution_task_claim ON distribution_task(state,available_at);
CREATE INDEX distribution_task_pair ON distribution_task(site_id,locale,state);
CREATE TABLE scheduled_publish (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 site_id text NOT NULL REFERENCES site(id), resource_id text NOT NULL REFERENCES resource(id),
 locale text NOT NULL CHECK(locale IN ('zh','en')),
 task_id uuid REFERENCES distribution_task(id) ON DELETE SET NULL,
 operation_id uuid NOT NULL, expected_published integer NOT NULL, expected_draft integer NOT NULL,
 publish_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done','missed','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0, claimed_until timestamptz, error text,
 created_by uuid REFERENCES operator_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz
);
CREATE UNIQUE INDEX scheduled_publish_one ON scheduled_publish(site_id,resource_id,locale) WHERE state='pending';
CREATE INDEX scheduled_publish_due ON scheduled_publish(state,publish_at);
