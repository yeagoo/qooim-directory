CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX publication_search_trgm ON publication USING gin (
  lower(title || ' ' || description || ' ' || seo_title || ' ' || seo_description) gin_trgm_ops
);
