-- Sign-in lockout: after 5 failed password attempts an account is locked for 5 minutes.
-- failed_login_attempts counts consecutive failures (reset on success or when a lock starts);
-- locked_until is when the current lock ends (NULL or in the past means not locked).
ALTER TABLE "User"
    ADD COLUMN IF NOT EXISTS failed_login_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS locked_until timestamptz;
