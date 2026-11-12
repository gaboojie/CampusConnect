import type { DatabaseClient } from "../client";
import { CAMPUS_NOW_SQL } from "./resources";

export const RESERVATION_REMINDER_NOTIFICATION = "reservation_reminder" as const;
export const RESERVATION_CANCELLED_NOTIFICATION = "reservation_cancelled" as const;
export const RESOURCE_REVIEW_DUE_NOTIFICATION = "resource_review_due" as const;
export const USER_REVIEW_DUE_NOTIFICATION = "user_review_due" as const;

export type NotificationType =
  | typeof RESERVATION_REMINDER_NOTIFICATION
  | typeof RESERVATION_CANCELLED_NOTIFICATION
  | typeof RESOURCE_REVIEW_DUE_NOTIFICATION
  | typeof USER_REVIEW_DUE_NOTIFICATION;

export type NotificationWorkflowPayload = {
  notificationId: number;
};

export type PendingNotification = {
  notification_id: number;
  email_workflow_id: string | null;
};

export type WorkflowNotification = {
  notification_id: number;
  user_id: number;
  reservation_id: number | null;
  message: string;
  notification_type: NotificationType;
  email_status: "pending" | "sent" | "skipped" | "failed" | null;
  scheduled_for_utc: string | Date | null;
  schedule_due: boolean;
  email: string;
  email_notifications_on: boolean;
  reservation_status: string | null;
  start_time: string | null;
  end_time: string | null;
  resource_name: string | null;
  building_name: string | null;
};

export function notificationWorkflowId(notificationId: number): string {
  return `notification-${notificationId}`;
}

export function notificationIdempotencyKey(notificationId: number): string {
  return `campusconnect-notification-${notificationId}`;
}

async function setWorkflowId(client: DatabaseClient, notificationId: number): Promise<void> {
  await client.query(
    `
      UPDATE "Notification"
      SET email_workflow_id = $2
      WHERE notification_id = $1
        AND email_workflow_id IS NULL
    `,
    [notificationId, notificationWorkflowId(notificationId)],
  );
}

export async function createReservationReminderNotification(
  client: DatabaseClient,
  reservationId: number,
): Promise<number> {
  const result = await client.query<{ notification_id: number }>(
    `
      INSERT INTO "Notification" (
        user_id,
        reservation_id,
        message,
        notification_type,
        scheduled_for,
        email_status
      )
      SELECT
        rv.user_id,
        rv.reservation_id,
        format(
          'Reminder: your reservation for %s in %s is scheduled for %s to %s.',
          r.name,
          b.building_name,
          to_char(rv.start_time, 'Mon DD, YYYY FMHH12:MI AM'),
          to_char(rv.end_time, 'FMHH12:MI AM')
        ),
        $2,
        rv.start_time - interval '1 hour',
        'pending'
      FROM "Reservation" AS rv
      JOIN "Resource" AS r ON r.resource_id = rv.resource_id
      JOIN "Building" AS b ON b.building_id = r.building_id
      WHERE rv.reservation_id = $1
        AND rv.status = 'confirmed'
      RETURNING notification_id
    `,
    [reservationId, RESERVATION_REMINDER_NOTIFICATION],
  );

  const notificationId = result.rows[0]?.notification_id;
  if (notificationId === undefined) {
    throw new Error(`Unable to create a reminder for reservation ${reservationId}.`);
  }

  await setWorkflowId(client, notificationId);
  return notificationId;
}

export async function createReservationCancellationNotification(
  client: DatabaseClient,
  input: { userId: number; reservationId: number; message: string },
): Promise<number> {
  const result = await client.query<{ notification_id: number }>(
    `
      INSERT INTO "Notification" (
        user_id,
        reservation_id,
        message,
        notification_type,
        scheduled_for,
        email_status
      )
      VALUES ($1, $2, $3, $4, ${CAMPUS_NOW_SQL}, 'pending')
      RETURNING notification_id
    `,
    [
      input.userId,
      input.reservationId,
      input.message,
      RESERVATION_CANCELLED_NOTIFICATION,
    ],
  );

  const notificationId = result.rows[0]?.notification_id;
  if (notificationId === undefined) {
    throw new Error(`Unable to create a cancellation notification for reservation ${input.reservationId}.`);
  }

  await setWorkflowId(client, notificationId);
  return notificationId;
}

// Review notifications are in-app only: email_status stays NULL so they are
// visible in the inbox without entering the email workflow.
export async function createDueReviewNotifications(client: DatabaseClient): Promise<number> {
  const result = await client.query<{ notification_id: number }>(
    `
      INSERT INTO "Notification" (
        user_id,
        reservation_id,
        message,
        notification_type,
        scheduled_for
      )
      SELECT due.user_id, due.reservation_id, due.message, due.notification_type, ${CAMPUS_NOW_SQL}
      FROM (
        SELECT
          rv.user_id,
          rv.reservation_id,
          format(
            'Please review %s from %s to %s.',
            resource.name,
            to_char(rv.start_time, 'Mon DD, YYYY FMHH12:MI AM'),
            to_char(rv.end_time, 'FMHH12:MI AM')
          ) AS message,
          $1::varchar AS notification_type
        FROM "Reservation" AS rv
        JOIN "Resource" AS resource ON resource.resource_id = rv.resource_id
        LEFT JOIN "ResourceReview" AS review ON review.reservation_id = rv.reservation_id
        WHERE rv.status IN ('confirmed', 'completed')
          AND rv.end_time <= ${CAMPUS_NOW_SQL}
          AND review.review_id IS NULL

        UNION ALL

        SELECT
          resource.owner_id AS user_id,
          rv.reservation_id,
          format(
            'Please review %s''s reservation of %s from %s to %s.',
            reserver.username,
            resource.name,
            to_char(rv.start_time, 'Mon DD, YYYY FMHH12:MI AM'),
            to_char(rv.end_time, 'FMHH12:MI AM')
          ) AS message,
          $2::varchar AS notification_type
        FROM "Reservation" AS rv
        JOIN "Resource" AS resource ON resource.resource_id = rv.resource_id
        JOIN "User" AS reserver ON reserver.user_id = rv.user_id
        LEFT JOIN "UserReview" AS review ON review.reservation_id = rv.reservation_id
        WHERE rv.status = 'completed'
          AND rv.end_time > ${CAMPUS_NOW_SQL} - interval '7 days'
          AND rv.end_time <= ${CAMPUS_NOW_SQL}
          AND rv.user_id <> resource.owner_id
          AND review.reservation_id IS NULL
      ) AS due
      ON CONFLICT (user_id, reservation_id, notification_type)
        WHERE notification_type IN ('resource_review_due', 'user_review_due')
      DO NOTHING
      RETURNING notification_id
    `,
    [RESOURCE_REVIEW_DUE_NOTIFICATION, USER_REVIEW_DUE_NOTIFICATION],
  );

  return result.rows.length;
}

export async function markReviewNotificationRead(
  client: DatabaseClient,
  input: {
    userId: number;
    reservationId: number;
    notificationType: typeof RESOURCE_REVIEW_DUE_NOTIFICATION | typeof USER_REVIEW_DUE_NOTIFICATION;
  },
): Promise<void> {
  await client.query(
    `
      UPDATE "Notification"
      SET read_at = COALESCE(read_at, ${CAMPUS_NOW_SQL})
      WHERE user_id = $1
        AND reservation_id = $2
        AND notification_type = $3
    `,
    [input.userId, input.reservationId, input.notificationType],
  );
}

export async function skipPendingReservationReminders(
  client: DatabaseClient,
  reservationId: number,
  reason: string,
): Promise<void> {
  await client.query(
    `
      UPDATE "Notification"
      SET email_status = 'skipped', email_error = $2
      WHERE reservation_id = $1
        AND notification_type = $3
        AND email_status = 'pending'
    `,
    [reservationId, reason, RESERVATION_REMINDER_NOTIFICATION],
  );
}

export async function listPendingNotifications(
  client: DatabaseClient,
  limit = 100,
): Promise<PendingNotification[]> {
  const result = await client.query<PendingNotification>(
    `
      SELECT notification_id, email_workflow_id
      FROM "Notification"
      WHERE email_status = 'pending'
      ORDER BY scheduled_for ASC NULLS FIRST, notification_id ASC
      LIMIT $1
    `,
    [limit],
  );

  return result.rows;
}

export async function ensureNotificationWorkflowId(
  client: DatabaseClient,
  notificationId: number,
  existingId?: string | null,
): Promise<string> {
  const workflowId = existingId ?? notificationWorkflowId(notificationId);
  const result = await client.query<{ email_workflow_id: string }>(
    `
      UPDATE "Notification"
      SET email_workflow_id = COALESCE(email_workflow_id, $2)
      WHERE notification_id = $1
        AND email_status = 'pending'
      RETURNING email_workflow_id
    `,
    [notificationId, workflowId],
  );

  return result.rows[0]?.email_workflow_id ?? workflowId;
}

export async function getWorkflowNotification(
  client: DatabaseClient,
  notificationId: number,
): Promise<WorkflowNotification | null> {
  const result = await client.query<WorkflowNotification>(
    `
      SELECT
        n.notification_id,
        n.user_id,
        n.reservation_id,
        n.message,
        n.notification_type,
        n.email_status,
        n.scheduled_for AT TIME ZONE 'America/New_York' AS scheduled_for_utc,
        n.scheduled_for <= ${CAMPUS_NOW_SQL} AS schedule_due,
        u.email,
        u.email_notifications_on,
        rv.status AS reservation_status,
        to_char(rv.start_time, 'Mon DD, YYYY FMHH12:MI AM') AS start_time,
        to_char(rv.end_time, 'FMHH12:MI AM') AS end_time,
        r.name AS resource_name,
        b.building_name
      FROM "Notification" AS n
      JOIN "User" AS u ON u.user_id = n.user_id
      LEFT JOIN "Reservation" AS rv ON rv.reservation_id = n.reservation_id
      LEFT JOIN "Resource" AS r ON r.resource_id = rv.resource_id
      LEFT JOIN "Building" AS b ON b.building_id = r.building_id
      WHERE n.notification_id = $1
    `,
    [notificationId],
  );

  return result.rows[0] ?? null;
}

export async function markNotificationSent(
  client: DatabaseClient,
  notificationId: number,
): Promise<void> {
  await client.query(
    `
      UPDATE "Notification"
      SET email_status = 'sent', email_sent_at = ${CAMPUS_NOW_SQL}, email_error = NULL
      WHERE notification_id = $1
        AND email_status = 'pending'
    `,
    [notificationId],
  );
}

export async function markNotificationSkipped(
  client: DatabaseClient,
  notificationId: number,
  reason: string,
): Promise<void> {
  await client.query(
    `
      UPDATE "Notification"
      SET email_status = 'skipped', email_error = $2
      WHERE notification_id = $1
        AND email_status = 'pending'
    `,
    [notificationId, reason],
  );
}

export async function markNotificationFailed(
  client: DatabaseClient,
  notificationId: number,
  reason: string,
): Promise<void> {
  await client.query(
    `
      UPDATE "Notification"
      SET email_status = 'failed', email_error = $2
      WHERE notification_id = $1
        AND email_status = 'pending'
    `,
    [notificationId, reason.slice(0, 2000)],
  );
}
