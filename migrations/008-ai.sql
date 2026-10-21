CREATE TABLE ai_config (
  site_id text PRIMARY KEY REFERENCES site(id),
  endpoint text NOT NULL,
  model text NOT NULL,
  sealed_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  monthly_tokens integer NOT NULL DEFAULT 100000 CHECK(monthly_tokens BETWEEN 1000 AND 100000000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id text NOT NULL REFERENCES site(id),
  actor_id uuid REFERENCES operator_user(id),
  kind text NOT NULL CHECK(kind IN ('generate','translate','seo')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','failed','cancelled')),
  output jsonb,
  provider_model text,
  prompt_version text NOT NULL DEFAULT 'v1',
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX ai_job_queue ON ai_job(status,available_at,created_at);
CREATE INDEX ai_job_site ON ai_job(site_id,created_at DESC);
