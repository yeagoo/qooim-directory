CREATE TABLE operator_user (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL,
 password_hash text NOT NULL, global_admin boolean NOT NULL DEFAULT false, disabled boolean NOT NULL DEFAULT false
);
CREATE TABLE operator_grant (
 user_id uuid REFERENCES operator_user(id), site_id text REFERENCES site(id),
 role text NOT NULL CHECK(role IN ('viewer','editor')), PRIMARY KEY(user_id,site_id)
);
CREATE TABLE operator_session (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES operator_user(id), expires_at timestamptz NOT NULL
);
CREATE TABLE login_limit (key text PRIMARY KEY, attempts integer NOT NULL, reset_at timestamptz NOT NULL);
CREATE TABLE audit_event (
 id bigserial PRIMARY KEY, actor_id uuid REFERENCES operator_user(id), site_id text REFERENCES site(id),
 action text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth_instance (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, site_id text UNIQUE NOT NULL REFERENCES site(id),
 origin text UNIQUE NOT NULL, center_site text REFERENCES site(id), sealed_secret text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','provisioning','ready','failed')),
 attempts integer NOT NULL DEFAULT 0, retry_at timestamptz NOT NULL DEFAULT now(),
 error_code text, schema_version text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE session_bridge (
 instance_id bigint NOT NULL REFERENCES auth_instance(id), local_session text NOT NULL, local_user text NOT NULL,
 canonical_session uuid UNIQUE NOT NULL REFERENCES identity_session(id), PRIMARY KEY(instance_id,local_session)
);
CREATE TABLE maintenance_status (name text PRIMARY KEY, completed_at timestamptz NOT NULL, detail jsonb NOT NULL DEFAULT '{}');
CREATE INDEX identity_session_center ON identity_session(space_id,center_session,user_id);
CREATE INDEX operator_session_expiry ON operator_session(expires_at);
CREATE INDEX audit_site ON audit_event(site_id,id);
CREATE INDEX auth_work ON auth_instance(state,retry_at);

ALTER TABLE identity_session ADD COLUMN checked_at timestamptz NOT NULL DEFAULT '-infinity';
CREATE INDEX identity_session_review ON identity_session(checked_at,id) WHERE NOT revoked;
