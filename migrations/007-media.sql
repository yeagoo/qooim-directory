CREATE TABLE media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id text NOT NULL REFERENCES site(id),
  filename text NOT NULL,
  mime text NOT NULL CHECK(mime IN ('image/jpeg','image/png','image/webp')),
  bytes bigint NOT NULL CHECK(bytes > 0),
  width integer NOT NULL CHECK(width > 0),
  height integer NOT NULL CHECK(height > 0),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  alt text NOT NULL DEFAULT '',
  created_by uuid REFERENCES operator_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(site_id,sha256)
);
CREATE INDEX media_site_created ON media(site_id,created_at DESC);
ALTER TABLE publication ADD COLUMN image jsonb;
DROP VIEW public_listing;
CREATE VIEW public_listing AS
 SELECT p.site_id,p.resource_id,p.locale,p.slug,p.title,p.description,p.url,p.seo_title,p.seo_description,p.category_id,p.rank,p.version,p.project,
   CASE WHEN p.image IS NULL THEN NULL ELSE jsonb_build_object('url','/media/'||(p.image->>'mediaId'),'alt',coalesce(p.image->>'alt','')) END AS image
 FROM publication p JOIN site s ON s.id=p.site_id JOIN resource r ON r.id=p.resource_id
 LEFT JOIN category c ON c.site_id=p.site_id AND c.id=p.category_id
 WHERE s.active AND r.public AND p.status='published' AND p.module=ANY(s.modules) AND 'directory'=ANY(s.modules)
 AND s.config->'locales' ? p.locale AND length(trim(p.title))>0
 AND (p.category_id IS NULL OR (c.active AND length(trim(c.labels->>p.locale))>0));
