-- M20: indexes for cross-site lookups by resource (distribution, duplicate check)
-- and for media-reference checks (media delete/version guards).
CREATE INDEX publication_resource ON publication(resource_id,locale);
CREATE INDEX content_draft_resource ON content_draft(resource_id,locale);
CREATE INDEX publication_image_media ON publication(site_id,((image->>'mediaId')::uuid)) WHERE image IS NOT NULL;
CREATE INDEX publication_logo_media ON publication(site_id,((logo->>'mediaId')::uuid)) WHERE logo IS NOT NULL;
CREATE INDEX publication_image_media_text ON publication(site_id,(image->>'mediaId')) WHERE image IS NOT NULL;
CREATE INDEX publication_logo_media_text ON publication(site_id,(logo->>'mediaId')) WHERE logo IS NOT NULL;
