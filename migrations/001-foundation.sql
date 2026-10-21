CREATE TABLE site (
 id text PRIMARY KEY, host text UNIQUE NOT NULL,
 active boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 0,
 draft_version integer NOT NULL DEFAULT 0,
 draft jsonb,
 config jsonb NOT NULL,
 modules text[] NOT NULL DEFAULT ARRAY['directory']
);
CREATE TABLE config_revision (
 site_id text NOT NULL REFERENCES site(id), revision integer NOT NULL,
 config jsonb NOT NULL, PRIMARY KEY(site_id, revision)
);
CREATE TABLE config_operation (
 id uuid PRIMARY KEY, site_id text NOT NULL REFERENCES site(id),
 fingerprint text NOT NULL, revision integer NOT NULL
);
CREATE TABLE outbox (
 id bigserial PRIMARY KEY, site_id text NOT NULL REFERENCES site(id),
 revision integer NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','failed')),
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, lease_token uuid, last_error text
);
CREATE INDEX outbox_claim ON outbox(status,available_at,lease_until,id);
CREATE TABLE config_delivery (
 site_id text PRIMARY KEY REFERENCES site(id), revision integer NOT NULL
);
CREATE TABLE resource (
 id text PRIMARY KEY, public boolean NOT NULL DEFAULT true, internal_note text NOT NULL DEFAULT ''
);
CREATE TABLE publication (
 site_id text NOT NULL REFERENCES site(id), resource_id text NOT NULL REFERENCES resource(id),
 locale text NOT NULL, slug text NOT NULL, title text NOT NULL,
 module text NOT NULL DEFAULT 'directory', status text NOT NULL DEFAULT 'draft',
 PRIMARY KEY(site_id, resource_id, locale), UNIQUE(site_id, locale, slug)
);
CREATE TABLE identity_space (
 id text PRIMARY KEY, center_site text NOT NULL REFERENCES site(id)
);
CREATE TABLE identity_site (
 site_id text PRIMARY KEY REFERENCES site(id), space_id text NOT NULL REFERENCES identity_space(id), UNIQUE(site_id,space_id)
);
CREATE TABLE identity_user (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), space_id text NOT NULL REFERENCES identity_space(id),
 email text NOT NULL CHECK(email=lower(trim(email))), banned boolean NOT NULL DEFAULT false,
 UNIQUE(space_id,email), UNIQUE(id,space_id)
);
CREATE TABLE identity_subject (
 space_id text NOT NULL, issuer text NOT NULL, subject text NOT NULL, user_id uuid NOT NULL,
 PRIMARY KEY(space_id,issuer,subject), FOREIGN KEY(user_id,space_id) REFERENCES identity_user(id,space_id)
);
CREATE TABLE identity_member (
 site_id text NOT NULL, space_id text NOT NULL, user_id uuid NOT NULL, role text NOT NULL DEFAULT 'reader',
 PRIMARY KEY(site_id,user_id), UNIQUE(site_id,space_id,user_id),
 FOREIGN KEY(site_id,space_id) REFERENCES identity_site(site_id,space_id),
 FOREIGN KEY(user_id,space_id) REFERENCES identity_user(id,space_id)
);
CREATE TABLE identity_session (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id text NOT NULL, space_id text NOT NULL, user_id uuid NOT NULL,
 center_session text NOT NULL, expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false,
 FOREIGN KEY(site_id,space_id,user_id) REFERENCES identity_member(site_id,space_id,user_id)
);
CREATE TABLE favorite (
 site_id text NOT NULL, space_id text NOT NULL, user_id uuid NOT NULL, resource_id text NOT NULL REFERENCES resource(id),
 PRIMARY KEY(site_id,user_id,resource_id),
 FOREIGN KEY(site_id,space_id,user_id) REFERENCES identity_member(site_id,space_id,user_id)
);
