import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import {
  ensureNotificationWorkflowId,
  getWorkflowNotification,
  listPendingNotifications,
  markNotificationFailed,
  markNotificationSent,
  markNotificationSkipped,
  notificationIdempotencyKey,
  notificationWorkflowId,
  type NotificationWorkflowPayload,
  type WorkflowNotification,
} from "../db/repositories/notifications";
import {
  defaultDatabaseClientFactory,
  withDatabase,
  type DatabaseClientFactory,
} from "../db/client";

export type NotificationWorkflowEnv = {
  DB?: Hyperdrive;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
};

export type NotificationWorkflowBinding = {
  create(options: {
    id: string;
    params: NotificationWorkflowPayload;
  }): Promise<unknown>;
  get?(id: string): Promise<{
    status(): Promise<{ status: string }>;
    restart(): Promise<void>;
  }>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown notification delivery error.";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function scheduledDate(value: string | Date): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Notification scheduled time is invalid.");
  }
  return date;
}

function skipReason(notification: WorkflowNotification): string | null {
  if (notification.email_status !== "pending") {
    return "Notification is no longer pending.";
  }
  if (!notification.email_notifications_on) {
    return "Email notifications are disabled for this user.";
  }
  if (
    notification.notification_type === "reservation_reminder" &&
    notification.reservation_status !== "confirmed"
  ) {
    return "The reservation is no longer confirmed.";
  }
  if (
    notification.notification_type === "reservation_reminder" &&
    notification.reservation_id === null
  ) {
    return "The reminder is not associated with a reservation.";
  }
  return null;
}

function emailSubject(notification: WorkflowNotification): string {
  return notification.notification_type === "reservation_cancelled"
    ? "Your CampusConnect reservation was cancelled"
    : "Upcoming CampusConnect reservation reminder";
}

function emailText(notification: WorkflowNotification): string {
  return [
    emailSubject(notification),
    "",
    notification.message,
    "",
    "CampusConnect is a CS 5614 class project. Do not share sensitive information.",
  ].join("\n");
}

function emailHtml(notification: WorkflowNotification): string {
  return [
    `<p><strong>${escapeHtml(emailSubject(notification))}</strong></p>`,
    `<p>${escapeHtml(notification.message).replaceAll("\n", "<br>")}</p>`,
    "<p>CampusConnect is a CS 5614 class project. Do not share sensitive information.</p>",
  ].join("\n");
}

export async function sendNotificationEmail(
  env: NotificationWorkflowEnv,
  notification: WorkflowNotification,
): Promise<void> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
    throw new Error("Resend is not configured.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": notificationIdempotencyKey(notification.notification_id),
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [notification.email],
      subject: emailSubject(notification),
      text: emailText(notification),
      html: emailHtml(notification),
    }),
  });

  if (!response.ok) {
    throw new Error(`Resend returned HTTP ${response.status}`);
  }
}

async function withNotificationDatabase<T>(
  env: NotificationWorkflowEnv,
  createDatabaseClient: DatabaseClientFactory,
  callback: (client: import("../db/client").DatabaseClient) => Promise<T>,
): Promise<T> {
  if (!env.DB) {
    throw new Error("Database is not configured.");
  }

  return withDatabase(env.DB.connectionString, createDatabaseClient, callback);
}

export async function startNotificationWorkflows(
  binding: NotificationWorkflowBinding | undefined,
  notifications: Array<{ notificationId: number; workflowId?: string | null }>,
): Promise<void> {
  if (!binding || notifications.length === 0) return;

  await Promise.all(
    notifications.map(async ({ notificationId, workflowId }) => {
      const id = workflowId ?? notificationWorkflowId(notificationId);
      try {
        await binding.create({
          id,
          params: { notificationId },
        });
      } catch (error) {
        const message = errorMessage(error).toLowerCase();
        if (message.includes("already") || message.includes("exist")) {
          if (!binding.get) return;
          try {
            const instance = await binding.get(id);
            const status = await instance.status();
            if (status.status === "errored" || status.status === "terminated") {
              await instance.restart();
            }
          } catch (restartError) {
            console.error(`Unable to recover notification workflow ${id}: ${errorMessage(restartError)}`);
          }
        } else {
          console.error(`Unable to start notification workflow ${id}: ${errorMessage(error)}`);
        }
      }
    }),
  );
}

export async function repairPendingNotificationWorkflows(
  env: NotificationWorkflowEnv,
  binding: NotificationWorkflowBinding | undefined,
  createDatabaseClient: DatabaseClientFactory = defaultDatabaseClientFactory,
): Promise<void> {
  if (!binding || !env.DB) return;

  const pending = await withNotificationDatabase(env, createDatabaseClient, (client) =>
    listPendingNotifications(client),
  );

  const notifications = await Promise.all(
    pending.map(async (notification) => {
      const workflowId = await withNotificationDatabase(env, createDatabaseClient, (client) =>
        ensureNotificationWorkflowId(
          client,
          notification.notification_id,
          notification.email_workflow_id,
        ),
      );
      return { notificationId: notification.notification_id, workflowId };
    }),
  );

  await startNotificationWorkflows(binding, notifications);
}

export async function runNotificationWorkflow(
  env: NotificationWorkflowEnv,
  payload: NotificationWorkflowPayload,
  step: WorkflowStep,
  createDatabaseClient: DatabaseClientFactory = defaultDatabaseClientFactory,
): Promise<{ status: "sent" | "skipped" | "failed" }> {
  const notificationId = payload.notificationId;

  const initial = await step.do(
    "load notification schedule",
    { retries: { limit: 0, delay: 0 } },
    () => withNotificationDatabase(
      env,
      createDatabaseClient,
      (client) => getWorkflowNotification(client, notificationId),
    ),
  );

  if (!initial) return { status: "skipped" };
  if (initial.email_status !== "pending") return { status: "skipped" };

  if (!initial.scheduled_for_utc) {
    await step.do(
      "mark missing schedule failed",
      { retries: { limit: 0, delay: 0 } },
      () => withNotificationDatabase(env, createDatabaseClient, (client) =>
        markNotificationFailed(client, notificationId, "Notification has no scheduled delivery time."),
      ).then(() => "failed"),
    );
    return { status: "failed" };
  }

  const deliveryAt = scheduledDate(initial.scheduled_for_utc);
  if (!initial.schedule_due && deliveryAt.getTime() > Date.now()) {
    await step.sleepUntil("wait until notification time", deliveryAt);
  }

  const current = await step.do(
    "check notification eligibility",
    { retries: { limit: 0, delay: 0 } },
    () => withNotificationDatabase(
      env,
      createDatabaseClient,
      (client) => getWorkflowNotification(client, notificationId),
    ),
  );

  if (!current) return { status: "skipped" };
  const reason = skipReason(current);
  if (reason) {
    await step.do(
      "mark notification skipped",
      { retries: { limit: 0, delay: 0 } },
      () => withNotificationDatabase(env, createDatabaseClient, (client) =>
        markNotificationSkipped(client, notificationId, reason),
      ).then(() => "skipped"),
    );
    return { status: "skipped" };
  }

  try {
    await step.do(
      "send notification email",
      { retries: { limit: 0, delay: 0 } },
      async () => {
        const latest = await withNotificationDatabase(
          env,
          createDatabaseClient,
          (client) => getWorkflowNotification(client, notificationId),
        );
        if (!latest) return "skipped";

        const latestReason = skipReason(latest);
        if (latestReason) {
          await withNotificationDatabase(env, createDatabaseClient, (client) =>
            markNotificationSkipped(client, notificationId, latestReason),
          );
          return "skipped";
        }

        await sendNotificationEmail(env, latest);
        await withNotificationDatabase(env, createDatabaseClient, (client) =>
          markNotificationSent(client, notificationId),
        );
        return "sent";
      },
    );
    return { status: "sent" };
  } catch (error) {
    const reason = errorMessage(error);
    try {
      await step.do(
        "mark notification failed",
        { retries: { limit: 0, delay: 0 } },
        () => withNotificationDatabase(env, createDatabaseClient, (client) =>
          markNotificationFailed(client, notificationId, reason),
        ).then(() => "failed"),
      );
    } catch (markError) {
      console.error(`Unable to mark notification ${notificationId} failed: ${errorMessage(markError)}`);
    }
    return { status: "failed" };
  }
}

export class NotificationWorkflow extends WorkflowEntrypoint<
  NotificationWorkflowEnv,
  NotificationWorkflowPayload
> {
  async run(
    event: Readonly<WorkflowEvent<NotificationWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<{ status: "sent" | "skipped" | "failed" }> {
    return runNotificationWorkflow(this.env, event.payload, step);
  }
}
