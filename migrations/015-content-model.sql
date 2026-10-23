-- M13a content model: per-site tags, extra categories, rich listing details, logo and publish times.
CREATE TABLE tag (
 site_id text NOT NULL REFERENCES site(id), id text NOT NULL, labels jsonb NOT NULL,
 rank integer NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
 PRIMARY KEY(site_id,id)
);
-- category_ids holds every category of the entry, the primary category_id first; tag_ids its tags.
-- Arrays cannot carry foreign keys: publishing validates that each id belongs to the site.
ALTER TABLE publication ADD COLUMN category_ids text[] NOT NULL DEFAULT '{}';
ALTER TABLE publication ADD COLUMN tag_ids text[] NOT NULL DEFAULT '{}';
-- Locale-resolved rich fields frozen at publish time (tagline, features, FAQ, Markdown content, ...).
ALTER TABLE publication ADD COLUMN details jsonb NOT NULL DEFAULT '{}';
ALTER TABLE publication ADD COLUMN logo jsonb;
ALTER TABLE publication ADD COLUMN first_published_at timestamptz;
ALTER TABLE publication ADD COLUMN published_at timestamptz;
UPDATE publication SET category_ids=ARRAY[category_id] WHERE category_id IS NOT NULL;
-- Existing entries take their publish times from the audit log; entries without one use the migration time.
UPDATE publication p SET first_published_at=coalesce(a.first_at,now()),published_at=coalesce(a.last_at,now())
 FROM (SELECT p2.site_id,p2.resource_id,p2.locale,min(e.created_at) AS first_at,max(e.created_at) AS last_at
       FROM publication p2 LEFT JOIN audit_event e ON e.action='publication.publish' AND e.site_id=p2.site_id
        AND e.detail->>'resource'=p2.resource_id AND e.detail->>'locale'=p2.locale
       GROUP BY p2.site_id,p2.resource_id,p2.locale) a
 WHERE a.site_id=p.site_id AND a.resource_id=p.resource_id AND a.locale=p.locale AND p.status='published';
CREATE INDEX publication_categories ON publication USING gin(category_ids);
CREATE INDEX publication_tags ON publication USING gin(tag_ids);
DROP VIEW public_listing;
-- category_ids/tag_ids are raw; readers join category/tag for labels and the active flag.
CREATE VIEW public_listing AS
 SELECT p.site_id,p.resource_id,p.locale,p.slug,p.title,p.description,p.url,p.seo_title,p.seo_description,p.category_id,p.rank,p.version,p.project,
   CASE WHEN p.image IS NULL THEN NULL ELSE jsonb_build_object('url','/media/'||(p.image->>'mediaId')||'/'||coalesce(p.image->>'version','1'),'alt',coalesce(p.image->>'alt','')) END AS image,
   (p.image->>'mediaId')::uuid AS image_media_id,
   coalesce((p.image->>'version')::int,1) AS image_version,
   CASE WHEN p.logo IS NULL THEN NULL ELSE jsonb_build_object('url','/media/'||(p.logo->>'mediaId')||'/'||(p.logo->>'version'),'alt',coalesce(p.logo->>'alt','')) END AS logo,
   (p.logo->>'mediaId')::uuid AS logo_media_id,
   (p.logo->>'version')::int AS logo_version,
   p.category_ids,p.tag_ids,p.details,
   p.first_published_at AS published_at,p.published_at AS updated_at
 FROM publication p JOIN site s ON s.id=p.site_id JOIN resource r ON r.id=p.resource_id
 LEFT JOIN category c ON c.site_id=p.site_id AND c.id=p.category_id
 WHERE s.active AND r.public AND p.status='published' AND p.module=ANY(s.modules) AND 'directory'=ANY(s.modules)
 AND s.config->'locales' ? p.locale AND length(trim(p.title))>0
 AND (p.category_id IS NULL OR (c.active AND length(trim(c.labels->>p.locale))>0));
