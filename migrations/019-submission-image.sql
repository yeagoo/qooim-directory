-- M16: an optional image attached to a submission. It is held here, outside the media
-- library and its quota, until review: accepting imports it into the media library as
-- the draft's logo, rejecting deletes it.
CREATE TABLE submission_image (
 submission_id uuid PRIMARY KEY REFERENCES submission(id) ON DELETE CASCADE,
 mime text NOT NULL CHECK(mime IN ('image/jpeg','image/png','image/webp')),
 bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 1048576),
 width integer NOT NULL CHECK(width > 0),
 height integer NOT NULL CHECK(height > 0),
 sha256 text NOT NULL,
 data bytea NOT NULL
);
