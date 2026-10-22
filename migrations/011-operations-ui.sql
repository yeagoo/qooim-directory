ALTER TABLE ai_job ADD COLUMN retry_of uuid REFERENCES ai_job(id) ON DELETE SET NULL;
CREATE INDEX ai_job_retry_of ON ai_job(retry_of) WHERE retry_of IS NOT NULL;
CREATE INDEX ai_job_site_status ON ai_job(site_id,status,created_at DESC);
ALTER TABLE collector_task ADD COLUMN retry_of uuid REFERENCES collector_task(id) ON DELETE SET NULL;
CREATE INDEX collector_task_retry_of ON collector_task(retry_of) WHERE retry_of IS NOT NULL;
