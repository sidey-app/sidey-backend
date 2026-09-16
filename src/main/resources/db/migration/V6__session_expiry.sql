create index user_sessions_pending_expiry on user_sessions(expires_at) where revoked_at is null;
