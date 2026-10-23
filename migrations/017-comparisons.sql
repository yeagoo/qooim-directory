-- M14b: reviewed "A vs B" comparison pages, one per site, language and pair.
CREATE TABLE comparison (
 site_id text NOT NULL REFERENCES site(id), locale text NOT NULL CHECK(locale IN ('zh','en')),
 id text NOT NULL, resource_a text NOT NULL REFERENCES resource(id), resource_b text NOT NULL REFERENCES resource(id),
 title text NOT NULL, content text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
 version integer NOT NULL DEFAULT 1, published_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(site_id,locale,id), CHECK(resource_a<>resource_b)
);
CREATE INDEX comparison_resources ON comparison(site_id,locale,resource_a,resource_b);
CREATE INDEX comparison_resource_b ON comparison(site_id,locale,resource_b);
ALTER TABLE ai_job DROP CONSTRAINT ai_job_kind_check;
ALTER TABLE ai_job ADD CONSTRAINT ai_job_kind_check CHECK(kind IN ('generate','translate','seo','enrich','compare'));
ALTER TABLE ai_prompt DROP CONSTRAINT ai_prompt_kind_check;
ALTER TABLE ai_prompt ADD CONSTRAINT ai_prompt_kind_check CHECK(kind IN ('generate','translate','seo','enrich','compare'));
