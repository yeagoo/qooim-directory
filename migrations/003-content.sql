ALTER TABLE resource ADD COLUMN version integer NOT NULL DEFAULT 0;
ALTER TABLE resource ADD COLUMN data jsonb;
CREATE TABLE resource_revision (
 resource_id text NOT NULL REFERENCES resource(id), version integer NOT NULL,
 data jsonb NOT NULL, PRIMARY KEY(resource_id,version)
);
CREATE TABLE category (
 site_id text NOT NULL REFERENCES site(id), id text NOT NULL, labels jsonb NOT NULL,
 rank integer NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
 PRIMARY KEY(site_id,id)
);
ALTER TABLE publication ADD COLUMN description text NOT NULL DEFAULT '';
ALTER TABLE publication ADD COLUMN url text NOT NULL DEFAULT '';
ALTER TABLE publication ADD COLUMN seo_title text NOT NULL DEFAULT '';
ALTER TABLE publication ADD COLUMN seo_description text NOT NULL DEFAULT '';
ALTER TABLE publication ADD COLUMN category_id text;
ALTER TABLE publication ADD COLUMN rank integer NOT NULL DEFAULT 0;
ALTER TABLE publication ADD COLUMN version integer NOT NULL DEFAULT 0;
ALTER TABLE publication ADD COLUMN source_version integer NOT NULL DEFAULT 0;
ALTER TABLE publication ADD COLUMN overrides jsonb NOT NULL DEFAULT '{}';
ALTER TABLE publication ADD CONSTRAINT publication_category FOREIGN KEY(site_id,category_id) REFERENCES category(site_id,id);
CREATE TABLE content_draft (
 site_id text NOT NULL REFERENCES site(id), resource_id text NOT NULL REFERENCES resource(id), locale text NOT NULL CHECK(locale IN ('zh','en')),
 version integer NOT NULL DEFAULT 1, candidate jsonb,
 PRIMARY KEY(site_id,resource_id,locale)
);
CREATE TABLE publication_revision (
 site_id text NOT NULL, resource_id text NOT NULL, locale text NOT NULL, version integer NOT NULL,
 snapshot jsonb NOT NULL, PRIMARY KEY(site_id,resource_id,locale,version),
 FOREIGN KEY(site_id,resource_id,locale) REFERENCES publication(site_id,resource_id,locale)
);
CREATE TABLE content_operation (
 id uuid PRIMARY KEY, fingerprint text NOT NULL, version integer NOT NULL
);
CREATE TABLE submission (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id text NOT NULL, space_id text NOT NULL, user_id uuid NOT NULL,
 data jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
 version integer NOT NULL DEFAULT 1, note text NOT NULL DEFAULT '', resource_id text REFERENCES resource(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(site_id,space_id,user_id) REFERENCES identity_member(site_id,space_id,user_id)
);
CREATE INDEX submission_rate ON submission(site_id,user_id,created_at);
CREATE INDEX submission_queue ON submission(site_id,status,created_at);
CREATE INDEX publication_browse ON publication(site_id,locale,status,rank,slug);
CREATE INDEX favorite_user ON favorite(site_id,user_id);
-- Every public content entry uses this same gate. It exposes no internal master fields.
CREATE VIEW public_listing AS
 SELECT p.site_id,p.resource_id,p.locale,p.slug,p.title,p.description,p.url,p.seo_title,p.seo_description,p.category_id,p.rank,p.version
 FROM publication p JOIN site s ON s.id=p.site_id JOIN resource r ON r.id=p.resource_id
 LEFT JOIN category c ON c.site_id=p.site_id AND c.id=p.category_id
 WHERE s.active AND r.public AND p.status='published' AND p.module=ANY(s.modules)
 AND s.config->'locales' ? p.locale AND length(trim(p.title))>0
 AND (p.category_id IS NULL OR (c.active AND length(trim(c.labels->>p.locale))>0));
