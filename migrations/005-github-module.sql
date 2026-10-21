ALTER TABLE publication ADD COLUMN project jsonb;
CREATE OR REPLACE VIEW public_listing AS
 SELECT p.site_id,p.resource_id,p.locale,p.slug,p.title,p.description,p.url,p.seo_title,p.seo_description,p.category_id,p.rank,p.version,p.project
 FROM publication p JOIN site s ON s.id=p.site_id JOIN resource r ON r.id=p.resource_id
 LEFT JOIN category c ON c.site_id=p.site_id AND c.id=p.category_id
 WHERE s.active AND r.public AND p.status='published' AND p.module=ANY(s.modules) AND 'directory'=ANY(s.modules)
 AND s.config->'locales' ? p.locale AND length(trim(p.title))>0
 AND (p.category_id IS NULL OR (c.active AND length(trim(c.labels->>p.locale))>0));
CREATE TABLE github_source (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),site_id text NOT NULL REFERENCES site(id),resource_id text NOT NULL UNIQUE,
 repository text NOT NULL,enabled boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1,
 interval_seconds integer NOT NULL DEFAULT 86400 CHECK(interval_seconds BETWEEN 3600 AND 604800),
 next_run_at timestamptz NOT NULL DEFAULT now(),etag text,last_hash text,remote_id text,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE github_task (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source_id uuid NOT NULL REFERENCES github_source(id),source_version integer NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),lease_token uuid,lease_until timestamptz,
 error_code text,result text,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz
);
CREATE UNIQUE INDEX github_one_open_task ON github_task(source_id) WHERE status IN ('pending','processing');
CREATE INDEX github_task_claim ON github_task(status,available_at,lease_until);
CREATE TABLE github_request(id uuid PRIMARY KEY,source_id uuid NOT NULL REFERENCES github_source(id),task_id uuid NOT NULL REFERENCES github_task(id));
CREATE TABLE github_candidate (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source_id uuid NOT NULL REFERENCES github_source(id),task_id uuid NOT NULL UNIQUE REFERENCES github_task(id),
 source_version integer NOT NULL,base_version integer NOT NULL,data jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','superseded')),
 version integer NOT NULL DEFAULT 1,applied_version integer,review_fingerprint text,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX github_review_queue ON github_candidate(source_id,status,created_at);
CREATE TABLE github_budget(id integer PRIMARY KEY CHECK(id=1),next_at timestamptz NOT NULL DEFAULT now());
INSERT INTO github_budget(id) VALUES(1);
