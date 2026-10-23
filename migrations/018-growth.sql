-- M15: per-user rate limit for submission metadata autofill.
CREATE TABLE metadata_fetch (
 site_id text NOT NULL,
 user_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(site_id,user_id) REFERENCES identity_member(site_id,user_id) ON DELETE CASCADE
);
CREATE INDEX metadata_fetch_rate ON metadata_fetch(site_id,user_id,created_at);
