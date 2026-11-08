-- In-app notification inbox: remember when the user read each notification.
-- NULL means unread. Existing rows start unread.
ALTER TABLE "Notification"
    ADD COLUMN IF NOT EXISTS read_at timestamp;

-- Speeds up the unread badge and the "Unread" filter for a user.
CREATE INDEX IF NOT EXISTS idx_notification_user_unread
    ON "Notification" (user_id)
    WHERE read_at IS NULL;
