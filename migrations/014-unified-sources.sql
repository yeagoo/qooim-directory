-- GitHub becomes a binding adapter on the unified source/task tables.
-- Binding sources are tied 1:1 to an existing resource; discovery sources (rss/npm/json) are not.
ALTER TABLE collector_source DROP CONSTRAINT collector_source_kind_check;
ALTER TABLE collector_source ADD CONSTRAINT collector_source_kind_check CHECK(kind IN ('rss','npm','json','github'));
ALTER TABLE collector_source ADD COLUMN resource_id text;
ALTER TABLE collector_source ADD COLUMN last_hash text;
ALTER TABLE collector_source ADD COLUMN remote_id text;
ALTER TABLE collector_source ADD CONSTRAINT collector_source_binding CHECK((kind='github') = (resource_id IS NOT NULL));
CREATE UNIQUE INDEX collector_source_resource ON collector_source(resource_id) WHERE resource_id IS NOT NULL;

-- Rows keep their ids, versions, cursors and task states.
INSERT INTO collector_source(id,site_id,kind,config,enabled,interval_seconds,version,etag,next_run_at,created_at,resource_id,last_hash,remote_id)
  SELECT id,site_id,'github',jsonb_build_object('repository',repository),enabled,interval_seconds,version,etag,next_run_at,created_at,resource_id,last_hash,remote_id
  FROM github_source;
INSERT INTO collector_task(id,source_id,source_version,status,attempts,available_at,lease_token,lease_until,error_code,result,created_at,completed_at)
  SELECT id,source_id,source_version,status,attempts,available_at,lease_token,lease_until,error_code,result,created_at,completed_at
  FROM github_task;

-- Field-level review candidates and request coalescing stay GitHub-specific but follow the unified tables.
-- Tasks may now be pruned by retention: candidates keep their row, request mappings go with the task.
ALTER TABLE github_candidate DROP CONSTRAINT github_candidate_source_id_fkey;
ALTER TABLE github_candidate DROP CONSTRAINT github_candidate_task_id_fkey;
ALTER TABLE github_candidate ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE github_candidate ADD CONSTRAINT github_candidate_source_id_fkey FOREIGN KEY(source_id) REFERENCES collector_source(id);
ALTER TABLE github_candidate ADD CONSTRAINT github_candidate_task_id_fkey FOREIGN KEY(task_id) REFERENCES collector_task(id) ON DELETE SET NULL;
ALTER TABLE github_request DROP CONSTRAINT github_request_source_id_fkey;
ALTER TABLE github_request DROP CONSTRAINT github_request_task_id_fkey;
ALTER TABLE github_request ADD CONSTRAINT github_request_source_id_fkey FOREIGN KEY(source_id) REFERENCES collector_source(id);
ALTER TABLE github_request ADD CONSTRAINT github_request_task_id_fkey FOREIGN KEY(task_id) REFERENCES collector_task(id) ON DELETE CASCADE;
CREATE INDEX github_request_task ON github_request(task_id);
CREATE INDEX github_candidate_retention ON github_candidate(created_at) WHERE status='superseded';

DROP TABLE github_task;
DROP TABLE github_source;
