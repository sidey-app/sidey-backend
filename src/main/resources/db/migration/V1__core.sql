CREATE TABLE users (
 id uuid PRIMARY KEY,
 status text NOT NULL CHECK(status IN ('ACTIVE','LEGACY_ANONYMOUS_UNCLAIMED')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_identities (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK(provider IN ('GOOGLE','APPLE')),
 provider_subject text NOT NULL CHECK(length(provider_subject) BETWEEN 1 AND 255),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,provider),
 UNIQUE(provider,provider_subject)
);
CREATE TABLE user_sessions (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 refresh_token_hash bytea NOT NULL UNIQUE CHECK(octet_length(refresh_token_hash)=32),
 created_at timestamptz NOT NULL,
 last_refreshed_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 absolute_expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 device_platform text NOT NULL CHECK(device_platform IN ('MACOS','WINDOWS','WEB','OTHER')),
 device_name text CHECK(length(device_name)<=100),
 CHECK(expires_at<=absolute_expires_at)
);
CREATE INDEX user_sessions_user ON user_sessions(user_id);
CREATE TABLE used_refresh_tokens (
 token_hash bytea PRIMARY KEY CHECK(octet_length(token_hash)=32),
 session_id uuid NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
CREATE INDEX used_refresh_tokens_expiry ON used_refresh_tokens(expires_at);
CREATE TABLE profiles (
 id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 nickname text NOT NULL CHECK(char_length(btrim(nickname)) BETWEEN 2 AND 8 AND nickname !~ E'[\n\r\t]'),
 character_id text NOT NULL DEFAULT 'pixel_hamster' CHECK(character_id ~ '^pixel_[a-z0-9_]{1,60}$'),
 equipped_bubble_style_id text CHECK(equipped_bubble_style_id ~ '^bubble_[a-z0-9_]{1,60}$'),
 equipped_throwable_id text CHECK(equipped_throwable_id ~ '^throwable_[a-z0-9_]{1,60}$'),
 tree_movement_paused boolean NOT NULL DEFAULT false,
 tree_movement_revision bigint NOT NULL DEFAULT 0 CHECK(tree_movement_revision>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rooms (
 id uuid PRIMARY KEY,
 name text NOT NULL CHECK(char_length(btrim(name)) BETWEEN 1 AND 20 AND name !~ E'[\n\r\t]'),
 owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE room_members (
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 joined_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(room_id,user_id)
);
CREATE INDEX room_members_user_joined ON room_members(user_id,joined_at,room_id);
ALTER TABLE rooms ADD CONSTRAINT owner_is_member FOREIGN KEY(id,owner_id)
 REFERENCES room_members(room_id,user_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE room_invites (
 room_id uuid PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
 code_hash bytea NOT NULL UNIQUE CHECK(octet_length(code_hash)=32),
 code_version bigint NOT NULL DEFAULT 1 CHECK(code_version>0),
 code_hint text NOT NULL CHECK(length(code_hint) BETWEEN 2 AND 20),
 created_at timestamptz NOT NULL DEFAULT now(),
 rotated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE invite_attempts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invite_attempts_user_time ON invite_attempts(user_id,attempted_at DESC);
CREATE TABLE messages (
 id uuid PRIMARY KEY,
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 body text NOT NULL CHECK(char_length(btrim(body)) BETWEEN 1 AND 200
  AND array_length(regexp_split_to_array(body,E'\n'),1)<=3 AND body !~ E'\r'),
 bubble_style_id text CHECK(bubble_style_id ~ '^bubble_[a-z0-9_]{1,60}$'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_room_cursor ON messages(room_id,created_at,id);
CREATE INDEX messages_retention ON messages(created_at);
CREATE TABLE message_attempts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_attempts_user_time ON message_attempts(user_id,attempted_at DESC);
-- Cross-table integrity is deferred so user and identity can be inserted in one transaction.
CREATE FUNCTION enforce_active_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
 IF TG_TABLE_NAME='users' THEN target:=NEW.id; ELSE target:=OLD.user_id; END IF;
 IF EXISTS(SELECT 1 FROM users WHERE id=target AND status='ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM user_identities WHERE user_id=target) THEN
  RAISE EXCEPTION 'active_user_requires_identity' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER active_user_identity AFTER INSERT OR UPDATE ON users
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_active_identity();
CREATE CONSTRAINT TRIGGER remaining_user_identity AFTER DELETE OR UPDATE ON user_identities
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_active_identity();
