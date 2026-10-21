ALTER TABLE identity_session ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE identity_session ADD COLUMN absolute_expires_at timestamptz;
UPDATE identity_session SET absolute_expires_at=expires_at;
ALTER TABLE identity_session ALTER COLUMN absolute_expires_at SET NOT NULL;
ALTER TABLE identity_session ALTER COLUMN absolute_expires_at SET DEFAULT (now()+interval '30 days');
ALTER TABLE identity_session ADD COLUMN revoked_at timestamptz;
UPDATE identity_session SET revoked_at=now() WHERE revoked;
CREATE FUNCTION identity_revocation_time() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.revoked AND NOT OLD.revoked THEN NEW.revoked_at=now(); END IF; RETURN NEW;
END $$;
CREATE TRIGGER identity_revocation_time BEFORE UPDATE ON identity_session FOR EACH ROW EXECUTE FUNCTION identity_revocation_time();
ALTER TABLE auth_instance ADD COLUMN provider_revision integer NOT NULL DEFAULT 0;
CREATE TABLE auth_provider (
 instance_id bigint NOT NULL REFERENCES auth_instance(id), id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('github','google','oidc')), label text NOT NULL,
 sealed_config text NOT NULL, enabled boolean NOT NULL DEFAULT true,
 PRIMARY KEY(instance_id,id)
);
CREATE TABLE auth_limit (key text PRIMARY KEY,attempts integer NOT NULL,reset_at timestamptz NOT NULL);
CREATE TABLE mail_queue (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),site_id text NOT NULL REFERENCES site(id),
 payload text,kind text NOT NULL CHECK(kind IN ('verify','reset')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','failed')),
 attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 lease_until timestamptz,lease_token uuid,error_code text,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_claim ON mail_queue(status,available_at,lease_until);
CREATE INDEX identity_history ON identity_session(expires_at,revoked_at);
