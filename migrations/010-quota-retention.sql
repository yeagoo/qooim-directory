CREATE TABLE site_limit (
  site_id text PRIMARY KEY REFERENCES site(id),
  media_bytes bigint CHECK(media_bytes BETWEEN 0 AND 1099511627776),
  media_files integer CHECK(media_files BETWEEN 0 AND 1000000),
  collector_sources integer CHECK(collector_sources BETWEEN 0 AND 1000),
  collector_runs_per_hour integer CHECK(collector_runs_per_hour BETWEEN 0 AND 10000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_usage_month (
  site_id text NOT NULL REFERENCES site(id),
  month date NOT NULL CHECK(month=date_trunc('month',month)::date),
  jobs integer NOT NULL DEFAULT 0 CHECK(jobs>=0),
  tokens_in bigint NOT NULL DEFAULT 0 CHECK(tokens_in>=0),
  tokens_out bigint NOT NULL DEFAULT 0 CHECK(tokens_out>=0),
  PRIMARY KEY(site_id,month)
);
CREATE INDEX ai_job_retention ON ai_job(completed_at) WHERE status IN ('done','failed','cancelled');
ALTER TABLE collector_candidate ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE collector_candidate DROP CONSTRAINT collector_candidate_task_id_fkey;
ALTER TABLE collector_candidate ADD CONSTRAINT collector_candidate_task_id_fkey FOREIGN KEY(task_id) REFERENCES collector_task(id) ON DELETE SET NULL;
ALTER TABLE collector_candidate ADD COLUMN reviewed_at timestamptz;
ALTER TABLE collector_candidate ADD COLUMN compacted_at timestamptz;
CREATE INDEX collector_candidate_task ON collector_candidate(task_id);
CREATE INDEX collector_candidate_retention ON collector_candidate((coalesce(reviewed_at,created_at))) WHERE status<>'pending' AND compacted_at IS NULL;
CREATE INDEX collector_task_retention ON collector_task(completed_at) WHERE status IN ('done','failed','cancelled');
CREATE INDEX collector_task_source_created ON collector_task(source_id,created_at);
