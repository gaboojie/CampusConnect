import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseClient, DatabaseQueryResult } from "../db/client";
import {
  runNotificationWorkflow,
  sendNotificationEmail,
  startNotificationWorkflows,
  type NotificationWorkflowEnv,
} from "../backend/notification-workflow";
import type { WorkflowStep } from "cloudflare:workers";
import type { WorkflowNotification } from "../db/repositories/notifications";

const notification: WorkflowNotification = {
  notification_id: 42,
  user_id: 7,
  reservation_id: 99,
  message: "Reminder: your reservation is scheduled for Mon Oct 20, 2026 10:00 AM to 11:00 AM.",
  notification_type: "reservation_reminder",
  email_status: "pending",
  scheduled_for_utc: "2026-10-30T13:00:00.000Z",
  schedule_due: false,
  email: "student@example.com",
  email_notifications_on: true,
  reservation_status: "confirmed",
  start_time: "Mon Oct 20, 2026 10:00 AM",
  end_time: "11:00 AM",
  resource_name: "Newman Group Study Room 1",
  building_name: "Carol M. Newman Library",
};

function environment(): NotificationWorkflowEnv {
  return {
    DB: { connectionString: "fake://database" } as Hyperdrive,
    RESEND_API_KEY: "dev-key",
    RESEND_FROM_EMAIL: "CampusConnect Development <no-reply@example.com>",
  };
}

function databaseFor(initial: WorkflowNotification = notification) {
  let status = initial.email_status;
  let error: string | null = null;
  const queries: string[] = [];
  const client: DatabaseClient = {
    connect: async () => {},
    end: async () => {},
    query: async <T = Record<string, unknown>>(
      text: string,
      _values: readonly unknown[] = [],
    ): Promise<DatabaseQueryResult<T>> => {
      queries.push(text);
      if (text.includes('FROM "Notification" AS n')) {
        return {
          rows: [{ ...initial, email_status: status }] as T[],
          rowCount: 1,
        };
      }
      if (text.includes("SET email_status = 'sent'")) {
        status = "sent";
        error = null;
      } else if (text.includes("SET email_status = 'skipped'")) {
        status = "skipped";
      } else if (text.includes("SET email_status = 'failed'")) {
        status = "failed";
        error = "delivery failed";
      }
      return { rows: [] as T[], rowCount: 0 };
    },
  };

  return {
    client,
    queries,
    getStatus: () => status,
    getError: () => error,
  };
}

function workflowStep() {
  const sleepUntil = vi.fn(async () => {});
  const doStep = vi.fn(async (_name: string, _config: unknown, callback: () => Promise<unknown>) => callback());
  return {
    step: { sleepUntil, do: doStep } as unknown as WorkflowStep,
    sleepUntil,
    doStep,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("notification email delivery", () => {
  it("sends a reminder with a deterministic Resend idempotency key", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await sendNotificationEmail(environment(), notification);

    expect(fetch).toHaveBeenCalledOnce();
    const request = (fetch.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((request.headers as Record<string, string>)["Idempotency-Key"])
      .toBe("campusconnect-notification-42");
    expect(JSON.parse(String(request.body))).toMatchObject({
      to: ["student@example.com"],
      subject: "Upcoming CampusConnect reservation reminder",
    });
  });

  it("marks a notification sent only after the workflow wait and eligibility check", async () => {
    const database = databaseFor();
    const step = workflowStep();
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    const result = await runNotificationWorkflow(
      environment(),
      { notificationId: 42 },
      step.step,
      () => database.client,
    );

    expect(result).toEqual({ status: "sent" });
    expect(step.sleepUntil).toHaveBeenCalledWith(
      "wait until notification time",
      new Date("2026-10-30T13:00:00.000Z"),
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(database.getStatus()).toBe("sent");
  });

  it("delivers an overdue reminder immediately instead of sleeping into the past", async () => {
    const database = databaseFor({ ...notification, schedule_due: true });
    const step = workflowStep();
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    const result = await runNotificationWorkflow(
      environment(),
      { notificationId: 42 },
      step.step,
      () => database.client,
    );

    expect(result).toEqual({ status: "sent" });
    expect(step.sleepUntil).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not sleep when the timestamp becomes overdue after the database check", async () => {
    const database = databaseFor({
      ...notification,
      scheduled_for_utc: new Date(Date.now() - 1_000),
      schedule_due: false,
    });
    const step = workflowStep();
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    const result = await runNotificationWorkflow(
      environment(),
      { notificationId: 42 },
      step.step,
      () => database.client,
    );

    expect(result).toEqual({ status: "sent" });
    expect(step.sleepUntil).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("skips a reminder when email notifications are disabled", async () => {
    const database = databaseFor({ ...notification, email_notifications_on: false });
    const step = workflowStep();
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    const result = await runNotificationWorkflow(
      environment(),
      { notificationId: 42 },
      step.step,
      () => database.client,
    );

    expect(result).toEqual({ status: "skipped" });
    expect(fetch).not.toHaveBeenCalled();
    expect(database.getStatus()).toBe("skipped");
  });

  it("marks a Resend failure as terminal without retrying the send step", async () => {
    const database = databaseFor();
    const step = workflowStep();
    const fetch = vi.fn(async () => new Response("failure", { status: 500 }));
    vi.stubGlobal("fetch", fetch);

    const result = await runNotificationWorkflow(
      environment(),
      { notificationId: 42 },
      step.step,
      () => database.client,
    );

    expect(result).toEqual({ status: "failed" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(database.getStatus()).toBe("failed");
  });
});

describe("notification workflow kickoff", () => {
  it("treats an existing deterministic instance as already scheduled", async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new Error("workflow instance already exists"))
      .mockResolvedValueOnce({ id: "notification-2" });

    await startNotificationWorkflows(
      { create },
      [{ notificationId: 1 }, { notificationId: 2 }],
    );

    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenNthCalledWith(1, {
      id: "notification-1",
      params: { notificationId: 1 },
    });
  });

  it("restarts an errored instance when its notification is still pending", async () => {
    const restart = vi.fn(async () => {});
    const get = vi.fn(async () => ({
      status: async () => ({ status: "errored" }),
      restart,
    }));
    const create = vi.fn(async () => {
      throw new Error("workflow instance already exists");
    });

    await startNotificationWorkflows(
      { create, get },
      [{ notificationId: 110 }],
    );

    expect(get).toHaveBeenCalledWith("notification-110");
    expect(restart).toHaveBeenCalledOnce();
  });
});
