-- Review notifications are unique per recipient, reservation, and review type.
-- The partial index leaves existing reminder/cancellation notification history
-- unchanged while making the periodic review sweep idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_review_notification_reservation_type_user
    ON "Notification" (user_id, reservation_id, notification_type)
    WHERE notification_type IN ('resource_review_due', 'user_review_due');
