import type { DatabaseClient } from "../client";
import {
  CAMPUS_NOW_SQL,
  localTimestampSql,
  maintenanceOverlapSql,
  parsePositiveId,
  parseSlot,
  reservationOverlapSql,
  slotFitsAvailabilitySql,
  type Slot,
  type Validation,
} from "./resources";
import {
  createReservationCancellationNotification,
  createReservationReminderNotification,
  skipPendingReservationReminders,
} from "./notifications";

export const MIN_RESERVATION_MINUTES = 15;
// Used when a resource does not set its own max_reservation_time.
export const DEFAULT_MAX_RESERVATION_SQL = "interval '4 hours'";

export type Reservation = {
  id: number;
  resource: { id: number; name: string };
  building: { id: number; name: string };
  startTime: string;
  endTime: string;
  status: string;
  createdAt: string;
  canModify: boolean;
};

export type MyReservations = {
  upcoming: Reservation[];
  past: Reservation[];
};

export type ServiceResult<T> =
  | { ok: true; value: T; notificationIds?: number[] }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

type ReservationRow = {
  reservation_id: number;
  status: string;
  start_time: string;
  end_time: string;
  created_at: string;
  resource_id: number;
  resource_name: string;
  building_id: number;
  building_name: string;
  can_modify: boolean;
  is_upcoming: boolean;
};

type CheckRow = {
  in_future: boolean;
  too_long: boolean;
  max_minutes: number | string;
  fits_availability: boolean;
  maintenance_conflict: boolean;
  self_conflict: boolean;
  resource_conflict: boolean;
};

const fail = (status: 400 | 403 | 404 | 409, error: string) =>
  ({ ok: false, status, error }) as const;

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

export function parseReservationSlot(body: unknown): Validation<Slot> {
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const slot = parseSlot(input.date, input.start, input.end);

  if (!slot.ok) return slot;
  if (!slot.value) {
    return { ok: false, error: "Choose a date, start time, and end time." };
  }

  const minutes = (text: string) => {
    const [hours, mins] = text.slice(-5).split(":").map(Number);
    return hours * 60 + mins;
  };
  if (minutes(slot.value.end) - minutes(slot.value.start) < MIN_RESERVATION_MINUTES) {
    return {
      ok: false,
      error: `Reservations must be at least ${MIN_RESERVATION_MINUTES} minutes long.`,
    };
  }

  return { ok: true, value: slot.value };
}

export function parseCreateReservation(
  body: unknown,
): Validation<{ resourceId: number; slot: Slot }> {
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const rawId = input.resourceId;
  const resourceId =
    typeof rawId === "number" || typeof rawId === "string" ? parsePositiveId(String(rawId)) : null;

  if (resourceId === null) {
    return { ok: false, error: "Choose a valid resource." };
  }

  const slot = parseReservationSlot(body);
  if (!slot.ok) return slot;

  return { ok: true, value: { resourceId, slot: slot.value } };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

function reservationSelectSql(source: string): string {
  return `
    SELECT
      rv.reservation_id,
      rv.status,
      ${localTimestampSql("rv.start_time")} AS start_time,
      ${localTimestampSql("rv.end_time")} AS end_time,
      ${localTimestampSql("rv.created_at")} AS created_at,
      r.resource_id,
      r.name AS resource_name,
      b.building_id,
      b.building_name,
      (rv.status = 'confirmed' AND rv.start_time > ${CAMPUS_NOW_SQL}) AS can_modify,
      (rv.end_time > ${CAMPUS_NOW_SQL}) AS is_upcoming
    FROM ${source} AS rv
    JOIN "Resource" AS r ON r.resource_id = rv.resource_id
    JOIN "Building" AS b ON b.building_id = r.building_id
  `;
}

export const LOCK_RESOURCE_SQL = `
  SELECT resource_id
  FROM "Resource"
  WHERE resource_id = $1
  FOR UPDATE
`;

// Serializes one user's bookings across different resources so two parallel
// requests cannot both pass the self-overlap check. NO KEY UPDATE does not block
// foreign-key inserts that reference the user (sessions, notifications).
export const LOCK_USER_SQL = `
  SELECT is_banned
  FROM "User"
  WHERE user_id = $1
  FOR NO KEY UPDATE
`;

// All slot rules in one round trip, evaluated while the locks are held.
// $1 resource, $2 start, $3 end, $4 user, $5 reservation to ignore (updates only).
export function buildSlotChecksSql(excludeReservation: boolean): string {
  const start = "$2::timestamp";
  const end = "$3::timestamp";
  const exclude = excludeReservation ? "$5::integer" : undefined;
  const maxLength = `COALESCE(r.max_reservation_time, ${DEFAULT_MAX_RESERVATION_SQL})`;

  return `
    SELECT
      ${start} > ${CAMPUS_NOW_SQL} AS in_future,
      (${end} - ${start}) > ${maxLength} AS too_long,
      (EXTRACT(EPOCH FROM ${maxLength}) / 60)::integer AS max_minutes,
      ${slotFitsAvailabilitySql("r.resource_id", start, end)} AS fits_availability,
      ${maintenanceOverlapSql("r.resource_id", start, end)} AS maintenance_conflict,
      EXISTS (
        SELECT 1
        FROM "Reservation" AS mine
        WHERE mine.user_id = $4
          AND mine.status <> 'cancelled'
          AND mine.start_time < ${end}
          AND mine.end_time > ${start}${exclude ? `\n          AND mine.reservation_id <> ${exclude}` : ""}
      ) AS self_conflict,
      ${reservationOverlapSql("r.resource_id", start, end, exclude)} AS resource_conflict
    FROM "Resource" AS r
    WHERE r.resource_id = $1
  `;
}

function formatMinutes(total: number): string {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const parts = [
    hours ? `${hours} hour${hours === 1 ? "" : "s"}` : "",
    minutes ? `${minutes} minute${minutes === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

// The first failed rule decides the error, from most to least fundamental.
function slotProblem(check: CheckRow): ServiceResult<never> | null {
  if (!check.in_future) {
    return fail(409, "That time has already passed. Choose a time in the future.");
  }
  if (check.too_long) {
    return fail(
      400,
      `This resource can be reserved for at most ${formatMinutes(Number(check.max_minutes))} at a time.`,
    );
  }
  if (!check.fits_availability) {
    return fail(409, "The resource isn't open for that whole time. Check its hours and try again.");
  }
  if (check.maintenance_conflict) {
    return fail(409, "The resource is scheduled for maintenance during that time.");
  }
  if (check.self_conflict) {
    return fail(409, "You already have another reservation that overlaps that time.");
  }
  if (check.resource_conflict) {
    return fail(409, "Someone else has already reserved this resource during that time.");
  }
  return null;
}

function toReservation(row: ReservationRow): Reservation {
  return {
    id: row.reservation_id,
    resource: { id: row.resource_id, name: row.resource_name },
    building: { id: row.building_id, name: row.building_name },
    startTime: row.start_time,
    endTime: row.end_time,
    status: row.status,
    createdAt: row.created_at,
    canModify: row.can_modify,
  };
}

function lockedStateProblem(row: { status: string; started: boolean }): ServiceResult<never> | null {
  if (row.status === "cancelled") {
    return fail(409, "This reservation has been cancelled and can no longer be changed.");
  }
  if (row.status !== "confirmed") {
    return fail(409, "This reservation is already over and can no longer be changed.");
  }
  if (row.started) {
    return fail(409, "This reservation has already started and can no longer be changed.");
  }
  return null;
}

async function inTransaction<T>(
  client: DatabaseClient,
  work: () => Promise<ServiceResult<T>>,
): Promise<ServiceResult<T>> {
  await client.query("BEGIN");

  try {
    const result = await work();
    await client.query(result.ok ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

// Takes the resource lock, then the user lock (always in this order), and
// rejects suspended accounts.
async function lockResourceAndUser(
  client: DatabaseClient,
  resourceId: number,
  userId: number,
): Promise<ServiceResult<null>> {
  const resource = await client.query(LOCK_RESOURCE_SQL, [resourceId]);
  if (resource.rows.length === 0) {
    return fail(404, "Resource not found.");
  }

  const user = await client.query<{ is_banned: boolean }>(LOCK_USER_SQL, [userId]);
  if (!user.rows[0] || user.rows[0].is_banned) {
    return fail(403, "Your account is suspended and cannot make reservations.");
  }

  return { ok: true, value: null };
}

async function checkSlot(
  client: DatabaseClient,
  resourceId: number,
  slot: Slot,
  userId: number,
  excludeReservationId?: number,
): Promise<ServiceResult<never> | null> {
  const exclude = excludeReservationId !== undefined;
  const values: unknown[] = [resourceId, slot.start, slot.end, userId];
  if (exclude) values.push(excludeReservationId);

  const result = await client.query<CheckRow>(buildSlotChecksSql(exclude), values);
  const check = result.rows[0];
  if (!check) {
    return fail(404, "Resource not found.");
  }
  return slotProblem(check);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export async function createReservation(
  client: DatabaseClient,
  userId: number,
  input: { resourceId: number; slot: Slot },
): Promise<ServiceResult<Reservation>> {
  return inTransaction<Reservation>(client, async () => {
    const locked = await lockResourceAndUser(client, input.resourceId, userId);
    if (!locked.ok) return locked;

    const problem = await checkSlot(client, input.resourceId, input.slot, userId);
    if (problem) return problem;

    const inserted = await client.query<ReservationRow>(
      `
        WITH inserted AS (
          INSERT INTO "Reservation" (user_id, resource_id, start_time, end_time, status)
          VALUES ($1, $2, $3::timestamp, $4::timestamp, 'confirmed')
          RETURNING *
        )
        ${reservationSelectSql("inserted")}
      `,
      [userId, input.resourceId, input.slot.start, input.slot.end],
    );

    const notificationId = await createReservationReminderNotification(
      client,
      inserted.rows[0].reservation_id,
    );

    return {
      ok: true,
      value: toReservation(inserted.rows[0]),
      notificationIds: [notificationId],
    };
  });
}

export async function rescheduleReservation(
  client: DatabaseClient,
  userId: number,
  reservationId: number,
  slot: Slot,
): Promise<ServiceResult<Reservation>> {
  return inTransaction<Reservation>(client, async () => {
    const existing = await client.query<{ user_id: number; resource_id: number }>(
      `
        SELECT user_id, resource_id
        FROM "Reservation"
        WHERE reservation_id = $1
      `,
      [reservationId],
    );
    const owner = existing.rows[0];
    if (!owner) return fail(404, "Reservation not found.");
    if (owner.user_id !== userId) return fail(403, "That reservation belongs to someone else.");

    const locked = await lockResourceAndUser(client, owner.resource_id, userId);
    if (!locked.ok) return locked;

    // Re-read under a row lock: a cancel or reschedule may have landed since the
    // unlocked read above.
    const current = await client.query<{ status: string; started: boolean }>(
      `
        SELECT status, start_time <= ${CAMPUS_NOW_SQL} AS started
        FROM "Reservation"
        WHERE reservation_id = $1
        FOR UPDATE
      `,
      [reservationId],
    );
    if (!current.rows[0]) return fail(404, "Reservation not found.");
    const stateProblem = lockedStateProblem(current.rows[0]);
    if (stateProblem) return stateProblem;

    const problem = await checkSlot(client, owner.resource_id, slot, userId, reservationId);
    if (problem) return problem;

    const updated = await client.query<ReservationRow>(
      `
        WITH updated AS (
          UPDATE "Reservation"
          SET start_time = $2::timestamp, end_time = $3::timestamp
          WHERE reservation_id = $1
          RETURNING *
        )
        ${reservationSelectSql("updated")}
      `,
      [reservationId, slot.start, slot.end],
    );

    await skipPendingReservationReminders(
      client,
      reservationId,
      "Reservation was rescheduled.",
    );
    const notificationId = await createReservationReminderNotification(client, reservationId);

    return {
      ok: true,
      value: toReservation(updated.rows[0]),
      notificationIds: [notificationId],
    };
  });
}

export async function cancelReservation(
  client: DatabaseClient,
  userId: number,
  reservationId: number,
): Promise<ServiceResult<Reservation>> {
  return inTransaction<Reservation>(client, async () => {
    const current = await client.query<{ user_id: number; status: string; started: boolean }>(
      `
        SELECT user_id, status, start_time <= ${CAMPUS_NOW_SQL} AS started
        FROM "Reservation"
        WHERE reservation_id = $1
        FOR UPDATE
      `,
      [reservationId],
    );
    const row = current.rows[0];
    if (!row) return fail(404, "Reservation not found.");
    if (row.user_id !== userId) return fail(403, "That reservation belongs to someone else.");

    const stateProblem = lockedStateProblem(row);
    if (stateProblem) return stateProblem;

    const updated = await client.query<ReservationRow>(
      `
        WITH updated AS (
          UPDATE "Reservation"
          SET status = 'cancelled'
          WHERE reservation_id = $1
          RETURNING *
        )
        ${reservationSelectSql("updated")}
      `,
      [reservationId],
    );

    await skipPendingReservationReminders(
      client,
      reservationId,
      "Reservation was cancelled.",
    );
    const notificationId = await createReservationCancellationNotification(client, {
      userId,
      reservationId,
      message: `You cancelled your reservation for ${updated.rows[0].resource_name} in ${updated.rows[0].building_name} on ${updated.rows[0].start_time}–${updated.rows[0].end_time}.`,
    });

    return {
      ok: true,
      value: toReservation(updated.rows[0]),
      notificationIds: [notificationId],
    };
  });
}

export async function listMyReservations(
  client: DatabaseClient,
  userId: number,
): Promise<MyReservations> {
  const result = await client.query<ReservationRow>(
    `
      ${reservationSelectSql('"Reservation"')}
      WHERE rv.user_id = $1
      ORDER BY rv.start_time ASC, rv.reservation_id ASC
    `,
    [userId],
  );

  const upcoming = result.rows.filter((row) => row.is_upcoming).map(toReservation);
  const past = result.rows
    .filter((row) => !row.is_upcoming)
    .map(toReservation)
    .reverse();

  return { upcoming, past };
}
