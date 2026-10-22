ALTER TABLE media ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version > 0);
ALTER TABLE media DROP CONSTRAINT media_site_id_sha256_key;
CREATE INDEX media_site_sha ON media(site_id,sha256);
CREATE TABLE media_version (
  media_id uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK(version > 0),
  filename text NOT NULL,
  mime text NOT NULL CHECK(mime IN ('image/jpeg','image/png','image/webp')),
  bytes bigint NOT NULL CHECK(bytes > 0),
  width integer NOT NULL CHECK(width > 0),
  height integer NOT NULL CHECK(height > 0),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  restored_from integer,
  created_by uuid REFERENCES operator_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(media_id,version)
);
CREATE INDEX media_version_sha ON media_version(sha256);
INSERT INTO media_version(media_id,version,filename,mime,bytes,width,height,sha256,created_by,created_at)
  SELECT id,1,filename,mime,bytes,width,height,sha256,created_by,created_at FROM media;
-- Publications freeze the image version they were published with; existing ones used version 1.
UPDATE publication SET image=image||'{"version":1}'::jsonb WHERE image IS NOT NULL AND NOT image ? 'version';
DROP VIEW public_listing;
CREATE VIEW public_listing AS
 SELECT p.site_id,p.resource_id,p.locale,p.slug,p.title,p.description,p.url,p.seo_title,p.seo_description,p.category_id,p.rank,p.version,p.project,
   CASE WHEN p.image IS NULL THEN NULL ELSE jsonb_build_object('url','/media/'||(p.image->>'mediaId')||'/'||coalesce(p.image->>'version','1'),'alt',coalesce(p.image->>'alt','')) END AS image,
   (p.image->>'mediaId')::uuid AS image_media_id,
   coalesce((p.image->>'version')::int,1) AS image_version
 FROM publication p JOIN site s ON s.id=p.site_id JOIN resource r ON r.id=p.resource_id
 LEFT JOIN category c ON c.site_id=p.site_id AND c.id=p.category_id
 WHERE s.active AND r.public AND p.status='published' AND p.module=ANY(s.modules) AND 'directory'=ANY(s.modules)
 AND s.config->'locales' ? p.locale AND length(trim(p.title))>0
 AND (p.category_id IS NULL OR (c.active AND length(trim(c.labels->>p.locale))>0));
