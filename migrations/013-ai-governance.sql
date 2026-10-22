-- Custom task instructions per kind. Version 1 is the built-in prompt kept in code.
CREATE TABLE ai_prompt (
  kind text NOT NULL CHECK(kind IN ('generate','translate','seo')),
  version integer NOT NULL CHECK(version >= 2),
  instructions text NOT NULL CHECK(length(instructions) BETWEEN 1 AND 4000),
  note text NOT NULL DEFAULT '' CHECK(length(note) <= 200),
  created_by uuid REFERENCES operator_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(kind,version)
);
-- Per-site choice of prompt version per kind, e.g. {"seo": 3}; missing kinds use version 1.
ALTER TABLE ai_config ADD COLUMN prompt_versions jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Provider-reported usage per site and month, entered by operators for reconciliation.
CREATE TABLE ai_usage_report (
  site_id text NOT NULL REFERENCES site(id),
  month date NOT NULL CHECK(month = date_trunc('month', month)::date),
  tokens_in bigint NOT NULL CHECK(tokens_in >= 0),
  tokens_out bigint NOT NULL CHECK(tokens_out >= 0),
  note text NOT NULL DEFAULT '' CHECK(length(note) <= 500),
  reported_by uuid REFERENCES operator_user(id),
  reported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(site_id,month)
);
-- Optional provider balance probe; the worker performs the outbound request.
CREATE TABLE ai_balance (
  site_id text PRIMARY KEY REFERENCES site(id),
  url text NOT NULL,
  field text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  requested_at timestamptz,
  checked_at timestamptz,
  value numeric,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_balance_due ON ai_balance(requested_at) WHERE enabled AND requested_at IS NOT NULL;
