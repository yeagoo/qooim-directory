-- M20: retention timestamps for idempotency keys and the outbox; visitor bans.
ALTER TABLE content_operation ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE config_operation ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE outbox ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX content_operation_age ON content_operation(created_at);
CREATE INDEX config_operation_age ON config_operation(created_at);
CREATE INDEX outbox_done_age ON outbox(created_at) WHERE status='done';
CREATE INDEX audit_event_age ON audit_event(created_at);
