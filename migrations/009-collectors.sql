CREATE TABLE collector_source (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id text NOT NULL REFERENCES site(id),
  kind text NOT NULL CHECK(kind IN ('rss','npm','json')),
  config jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  interval_seconds integer NOT NULL DEFAULT 86400 CHECK(interval_seconds BETWEEN 3600 AND 604800),
  version integer NOT NULL DEFAULT 1,
  etag text,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE collector_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES collector_source(id),
  source_version integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  error_code text,
  result text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX collector_task_queue ON collector_task(status,available_at,created_at);
CREATE TABLE collector_candidate (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES collector_source(id),
  task_id uuid NOT NULL REFERENCES collector_task(id),
  external_id text NOT NULL,
  locale text NOT NULL CHECK(locale IN ('zh','en')),
  data jsonb NOT NULL,
  fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','superseded')),
  version integer NOT NULL DEFAULT 1,
  accepted_resource_id text,
  review_fingerprint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_id,external_id)
);
CREATE INDEX collector_candidate_queue ON collector_candidate(source_id,status,created_at);
