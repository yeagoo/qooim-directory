-- M13b: per-site curated collections (hot, editor's picks, ...) and the AI "enrich" kind.
CREATE TABLE collection (
 site_id text NOT NULL REFERENCES site(id), id text NOT NULL, labels jsonb NOT NULL,
 descriptions jsonb NOT NULL DEFAULT '{}', rank integer NOT NULL DEFAULT 0,
 active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
 PRIMARY KEY(site_id,id)
);
-- Members are resources; each locale shows the ones visible in public_listing, in rank order.
CREATE TABLE collection_item (
 site_id text NOT NULL, collection_id text NOT NULL, resource_id text NOT NULL REFERENCES resource(id),
 rank integer NOT NULL,
 PRIMARY KEY(site_id,collection_id,resource_id),
 FOREIGN KEY(site_id,collection_id) REFERENCES collection(site_id,id) ON DELETE CASCADE
);
CREATE INDEX collection_item_order ON collection_item(site_id,collection_id,rank);
ALTER TABLE ai_job DROP CONSTRAINT ai_job_kind_check;
ALTER TABLE ai_job ADD CONSTRAINT ai_job_kind_check CHECK(kind IN ('generate','translate','seo','enrich'));
ALTER TABLE ai_prompt DROP CONSTRAINT ai_prompt_kind_check;
ALTER TABLE ai_prompt ADD CONSTRAINT ai_prompt_kind_check CHECK(kind IN ('generate','translate','seo','enrich'));
