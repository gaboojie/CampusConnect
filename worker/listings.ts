import type { DatabaseClient } from "./db";
import {
  AVAILABILITY_REPEAT_INTERVALS,
  AVAILABILITY_REPEATS,
  CAMPUS_NOW_SQL,
  getResourceDetails,
  localTimestampSql,
  slotFitsAvailabilitySql,
  shortenDescription,
  type AvailabilityRepeat,
  type AvailabilitySlot,
  type ResourceDetails,
  type ResourceSummary,
  type Validation,
} from "./resources";

const MAX_IMAGE_BYTES = 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type AvailabilityInput = Omit<AvailabilitySlot, "id">;

export type ListingInput = {
  name: string;
  description: string;
  locationDescription: string;
  buildingId: number;
  categoryId: number;
  requiredCredits: number;
  capacity: number;
  maxReservationMinutes: number | null;
  availability: AvailabilityInput[] | null;
  image: File | null;
  removeImage: boolean;
};

export type ListingSummary = ResourceSummary & {
  hasActiveReservation: boolean;
  activeReservation: { startTime: string; endTime: string } | null;
};

export type ListingDetails = ResourceDetails & {
  hasActiveReservation: boolean;
  activeReservation: { startTime: string; endTime: string } | null;
  availability: AvailabilitySlot[];
};

export type ListingResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 403 | 404 | 409 | 503; error: string };

function fail<T>(status: 400 | 403 | 404 | 409 | 503, error: string): ListingResult<T> {
  return { ok: false, status, error };
}

function text(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === "string" ? value.trim() : "";
}

function integer(body: Record<string, unknown>, name: string): number | null {
  const value = text(body, name);
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function optionalInteger(body: Record<string, unknown>, name: string): number | null | undefined {
  const value = text(body, name);
  if (!value) return null;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseImage(value: unknown): File | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof File === "undefined" || !(value instanceof File)) return undefined;
  return value.size === 0 ? null : value;
}

const LOCAL_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T| )([01]\d|2[0-3]):([0-5]\d)$/;

function parseLocalDateTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = LOCAL_DATETIME_PATTERN.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute)
  ) return null;
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function localDateTimeMs(value: string): number {
  return Date.parse(`${value.replace(" ", "T")}:00Z`);
}

function repeatIntervalDays(repeat: AvailabilityRepeat): number | null {
  if (repeat === "none") return null;
  return Number(AVAILABILITY_REPEAT_INTERVALS[repeat].split(" ")[0]);
}

function parseAvailability(value: unknown): Validation<AvailabilityInput[] | null> {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "Availability must be a JSON array." };

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ok: false, error: "Availability must be a valid JSON array." };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, error: "Add at least one availability slot." };
  }

  const slots: AvailabilityInput[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      return { ok: false, error: "Each availability slot must be an object." };
    }
    const row = entry as Record<string, unknown>;
    const startTime = parseLocalDateTime(row.startTime);
    const endTime = parseLocalDateTime(row.endTime);
    if (!startTime || !endTime) {
      return { ok: false, error: "Availability times must use a valid local date and time." };
    }
    if (localDateTimeMs(endTime) <= localDateTimeMs(startTime)) {
      return { ok: false, error: "Availability end time must be after its start time." };
    }

    const repeat = typeof row.repeat === "string" ? row.repeat as AvailabilityRepeat : "";
    if (!AVAILABILITY_REPEATS.includes(repeat as AvailabilityRepeat)) {
      return { ok: false, error: "Choose a valid availability repeat option." };
    }

    const rawRepeatsUntil = row.repeatsUntil;
    const repeatsUntil = rawRepeatsUntil === null || rawRepeatsUntil === undefined || rawRepeatsUntil === ""
      ? null
      : parseLocalDateTime(rawRepeatsUntil);
    if (rawRepeatsUntil !== null && rawRepeatsUntil !== undefined && rawRepeatsUntil !== "" && !repeatsUntil) {
      return { ok: false, error: "Repeats until must use a valid local date and time." };
    }
    if (repeat === "none" && repeatsUntil !== null) {
      return { ok: false, error: "A non-repeating availability slot cannot have a repeats-until time." };
    }
    if (repeat !== "none" && repeatsUntil === null) {
      return { ok: false, error: "Repeating availability slots require a repeats-until time." };
    }
    if (repeatsUntil && localDateTimeMs(repeatsUntil) <= localDateTimeMs(endTime)) {
      return { ok: false, error: "Repeats until must be after the availability end time." };
    }

    const intervalDays = repeatIntervalDays(repeat);
    if (intervalDays !== null && localDateTimeMs(endTime) - localDateTimeMs(startTime) > intervalDays * 24 * 60 * 60 * 1000) {
      return { ok: false, error: "A repeating availability window cannot exceed its repeat interval." };
    }
    slots.push({ startTime, endTime, repeat, repeatsUntil });
  }

  return { ok: true, value: slots };
}

export function parseListingInput(body: Record<string, unknown>): Validation<ListingInput> {
  const name = text(body, "name");
  const description = text(body, "description");
  const locationDescription = text(body, "locationDescription");
  const buildingId = integer(body, "buildingId");
  const categoryId = integer(body, "categoryId");
  const requiredCredits = integer(body, "requiredCredits");
  const capacity = integer(body, "capacity");
  const hours = optionalInteger(body, "maxReservationHours");
  const minutes = optionalInteger(body, "maxReservationMinutes");
  const availability = parseAvailability(body.availability);
  const image = parseImage(body.image);
  const errors: string[] = [];

  if (!availability.ok) errors.push(availability.error);

  if (name.length < 3) errors.push("Name must be at least 3 characters.");
  if (description.length < 3) errors.push("Description must be at least 3 characters.");
  if (locationDescription.length < 3) {
    errors.push("Location description must be at least 3 characters.");
  }
  if (buildingId === null || buildingId < 1) errors.push("Choose a building.");
  if (categoryId === null || categoryId < 1) errors.push("Choose a category.");
  if (requiredCredits === null || requiredCredits < 1 || requiredCredits > 20) {
    errors.push("Credits must be a whole number between 1 and 20.");
  }
  if (capacity === null || capacity < 1 || capacity > 100) {
    errors.push("Capacity must be a whole number between 1 and 100.");
  }
  if (hours === undefined || minutes === undefined) {
    errors.push("Maximum reservation time must use whole hours and minutes.");
  } else if (hours !== null || minutes !== null) {
    const total = (hours ?? 0) * 60 + (minutes ?? 0);
    if ((minutes ?? 0) > 59 || total < 1) {
      errors.push("Maximum reservation time must be at least one minute.");
    }
  }
  if (image === undefined) errors.push("Upload a valid image file.");
  if (image && !ALLOWED_IMAGE_TYPES.has(image.type)) {
    errors.push("Images must be JPEG, PNG, or WebP files.");
  }
  if (image && image.size > MAX_IMAGE_BYTES) errors.push("Images must be 1 MB or smaller.");

  if (errors.length > 0) return { ok: false, error: errors[0] };

  return {
    ok: true,
    value: {
      name,
      description,
      locationDescription,
      buildingId: buildingId!,
      categoryId: categoryId!,
      requiredCredits: requiredCredits!,
      capacity: capacity!,
      maxReservationMinutes:
        hours === null && minutes === null ? null : (hours ?? 0) * 60 + (minutes ?? 0),
      availability: availability.value,
      image: image!,
      removeImage: text(body, "removeImage") === "true",
    },
  };
}

function intervalValue(minutes: number | null): string | null {
  return minutes === null ? null : `${minutes} minutes`;
}

function objectKey(ownerId: number, resourceId: number, file: File): string {
  const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const suffix = crypto.randomUUID();
  return `resources/${ownerId}/${resourceId}/${suffix}.${extension}`;
}

async function verifyReferences(client: DatabaseClient, buildingId: number, categoryId: number): Promise<string | null> {
  const result = await client.query<{ building_id: number; category_id: number }>(
    `
      SELECT
        EXISTS (SELECT 1 FROM "Building" WHERE building_id = $1) AS building_id,
        EXISTS (SELECT 1 FROM "ResourceCategory" WHERE category_id = $2) AS category_id
    `,
    [buildingId, categoryId],
  );
  const row = result.rows[0];
  if (!row?.building_id) return "Choose a valid building.";
  if (!row.category_id) return "Choose a valid category.";
  return null;
}

async function uploadImage(
  bucket: R2Bucket | undefined,
  file: File,
  key: string,
): Promise<ListingResult<null>> {
  if (!bucket) return fail(503, "Image storage is not configured right now.");
  try {
    await bucket.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type },
      customMetadata: { filename: file.name },
    });
    return { ok: true, value: null };
  } catch {
    return fail(503, "Unable to save the resource image right now.");
  }
}

async function bestEffortDelete(bucket: R2Bucket | undefined, key: string | null): Promise<void> {
  if (!bucket || !key) return;
  try {
    await bucket.delete(key);
  } catch (error) {
    console.error(`R2 cleanup failed for ${key}:`, error);
  }
}

async function activeReservation(
  client: DatabaseClient,
  resourceId: number,
): Promise<{ startTime: string; endTime: string } | null> {
  const result = await client.query<{ start_time: string; end_time: string }>(
    `
      SELECT
        ${localTimestampSql("start_time")} AS start_time,
        ${localTimestampSql("end_time")} AS end_time
      FROM "Reservation"
      WHERE resource_id = $1
        AND status = 'confirmed'
        AND start_time <= ${CAMPUS_NOW_SQL}
        AND end_time > ${CAMPUS_NOW_SQL}
      ORDER BY start_time, reservation_id
      LIMIT 1
    `,
    [resourceId],
  );
  const row = result.rows[0];
  return row ? { startTime: row.start_time, endTime: row.end_time } : null;
}

function activeMessage(reservation: { startTime: string; endTime: string }): string {
  return `This listing cannot be changed while a reservation is in progress (${reservation.startTime}–${reservation.endTime}).`;
}

async function ownedResource(
  client: DatabaseClient,
  resourceId: number,
  ownerId: number,
  lock: boolean,
): Promise<ListingResult<{
  name: string;
  requiredCredits: number;
  imageId: number | null;
  objectKey: string | null;
  active: { startTime: string; endTime: string } | null;
}>> {
  const result = await client.query<{
    owner_id: number;
    name: string;
    required_credits: number;
    image_id: number | null;
    object_key: string | null;
    active_start: string | null;
    active_end: string | null;
  }>(
    `
      SELECT
        r.owner_id,
        r.name,
        r.required_credits,
        img.image_id,
        img.object_key,
        ${localTimestampSql("active.start_time")} AS active_start,
        ${localTimestampSql("active.end_time")} AS active_end
      FROM "Resource" AS r
      LEFT JOIN "ImageMetadata" AS img ON img.image_id = r.resource_image_id
      LEFT JOIN LATERAL (
        SELECT start_time, end_time
        FROM "Reservation"
        WHERE resource_id = r.resource_id
          AND status = 'confirmed'
          AND start_time <= ${CAMPUS_NOW_SQL}
          AND end_time > ${CAMPUS_NOW_SQL}
        ORDER BY start_time, reservation_id
        LIMIT 1
      ) AS active ON TRUE
      WHERE r.resource_id = $1
      ${lock ? "FOR UPDATE OF r" : ""}
    `,
    [resourceId],
  );
  const row = result.rows[0];
  if (!row) return fail(404, "Resource not found.");
  if (row.owner_id !== ownerId) return fail(403, "That resource belongs to someone else.");
  return {
    ok: true,
    value: {
      name: row.name,
      requiredCredits: row.required_credits,
      imageId: row.image_id,
      objectKey: row.object_key,
      active: row.active_start && row.active_end
        ? { startTime: row.active_start, endTime: row.active_end }
        : null,
    },
  };
}

async function getOwnedAvailability(client: DatabaseClient, resourceId: number): Promise<AvailabilitySlot[]> {
  const result = await client.query<{
    availability_id: number;
    start_time: string;
    end_time: string;
    repeats_until: string | null;
    repeat: AvailabilityRepeat;
  }>(
    `
      SELECT
        availability_id,
        to_char(start_time, 'YYYY-MM-DD"T"HH24:MI') AS start_time,
        to_char(end_time, 'YYYY-MM-DD"T"HH24:MI') AS end_time,
        to_char(repeats_until, 'YYYY-MM-DD"T"HH24:MI') AS repeats_until,
        CASE repeats_offset
          WHEN interval '1 day' THEN 'daily'
          WHEN interval '2 days' THEN 'every_other_day'
          WHEN interval '7 days' THEN 'weekly'
          WHEN interval '14 days' THEN 'every_other_week'
          ELSE 'none'
        END AS repeat
      FROM "ResourceAvailability"
      WHERE resource_id = $1
      ORDER BY start_time, availability_id
    `,
    [resourceId],
  );
  return result.rows.map((row) => ({
    id: row.availability_id,
    startTime: row.start_time,
    endTime: row.end_time,
    repeat: row.repeat,
    repeatsUntil: row.repeats_until,
  }));
}

async function insertAvailability(
  client: DatabaseClient,
  resourceId: number,
  availability: AvailabilityInput[] | null,
): Promise<void> {
  if (availability === null) {
    await client.query(
      `
        INSERT INTO "ResourceAvailability" (resource_id, start_time, end_time)
        VALUES ($1, ${CAMPUS_NOW_SQL}, ${CAMPUS_NOW_SQL} + interval '1 year')
      `,
      [resourceId],
    );
    return;
  }

  const values: unknown[] = [];
  const rows = availability.map((slot, index) => {
    const base = index * 5;
    values.push(
      resourceId,
      slot.startTime,
      slot.endTime,
      slot.repeatsUntil,
      slot.repeat === "none" ? null : AVAILABILITY_REPEAT_INTERVALS[slot.repeat],
    );
    return `($${base + 1}, $${base + 2}::timestamp, $${base + 3}::timestamp, $${base + 4}::timestamp, $${base + 5}::interval)`;
  });

  await client.query(
    `
      INSERT INTO "ResourceAvailability" (resource_id, start_time, end_time, repeats_until, repeats_offset)
      VALUES ${rows.join(",\n")}
    `,
    values,
  );
}

async function validateAvailabilitySet(client: DatabaseClient, resourceId: number): Promise<string | null> {
  const result = await client.query<{ has_overlap: boolean }>(
    `
      WITH occurrences AS (
        SELECT
          a.availability_id,
          a.resource_id,
          a.start_time + k * COALESCE(a.repeats_offset, interval '0') AS occurrence_start,
          CASE
            WHEN a.repeats_offset IS NULL THEN a.end_time
            ELSE a.start_time + k * a.repeats_offset + (a.end_time - a.start_time)
          END AS occurrence_end
        FROM "ResourceAvailability" AS a
        CROSS JOIN LATERAL generate_series(
          0,
          CASE
            WHEN a.repeats_offset IS NULL THEN 0
            ELSE FLOOR(
              EXTRACT(EPOCH FROM (a.repeats_until - a.start_time))
              / NULLIF(EXTRACT(EPOCH FROM a.repeats_offset), 0)
            )::integer
          END
        ) AS k
        WHERE a.resource_id = $1
      )
      SELECT EXISTS (
        SELECT 1
        FROM occurrences AS first_slot
        JOIN occurrences AS second_slot
          ON second_slot.resource_id = first_slot.resource_id
         AND second_slot.availability_id > first_slot.availability_id
         AND first_slot.occurrence_start < second_slot.occurrence_end
         AND second_slot.occurrence_start < first_slot.occurrence_end
      ) AS has_overlap
    `,
    [resourceId],
  );
  return result.rows[0]?.has_overlap ? "Availability slots cannot overlap." : null;
}

type AffectedReservation = {
  reservation_id: number;
  user_id: number;
  start_time: string;
  end_time: string;
};

async function cancelAffectedReservations(
  client: DatabaseClient,
  resourceId: number,
  resourceName: string,
  requiredCredits: number,
): Promise<number> {
  const affected = await client.query<AffectedReservation>(
    `
      SELECT
        rv.reservation_id,
        rv.user_id,
        ${localTimestampSql("rv.start_time")} AS start_time,
        ${localTimestampSql("rv.end_time")} AS end_time
      FROM "Reservation" AS rv
      WHERE rv.resource_id = $1
        AND rv.status = 'confirmed'
        AND rv.start_time > ${CAMPUS_NOW_SQL}
        AND NOT ${slotFitsAvailabilitySql("rv.resource_id", "rv.start_time", "rv.end_time")}
      ORDER BY rv.user_id, rv.reservation_id
      FOR UPDATE
    `,
    [resourceId],
  );

  if (affected.rows.length === 0) return 0;
  const userIds = [...new Set(affected.rows.map((row) => row.user_id))];
  await client.query(
    `SELECT user_id FROM "User" WHERE user_id = ANY($1::integer[]) ORDER BY user_id FOR UPDATE`,
    [userIds],
  );

  for (const reservation of affected.rows) {
    await client.query(
      `UPDATE "Reservation" SET status = 'cancelled' WHERE reservation_id = $1 AND status = 'confirmed'`,
      [reservation.reservation_id],
    );
    await client.query(
      `UPDATE "User" SET credit_balance = credit_balance + $2 WHERE user_id = $1`,
      [reservation.user_id, requiredCredits],
    );
    await client.query(
      `INSERT INTO "CreditTransaction" (user_id, amount, transaction_type) VALUES ($1, $2, 'refund')`,
      [reservation.user_id, requiredCredits],
    );
    await client.query(
      `
        INSERT INTO "Notification" (user_id, message, notification_type)
        VALUES ($1, $2, 'reservation_cancelled')
      `,
      [
        reservation.user_id,
        `Your reservation for ${resourceName} on ${reservation.start_time}–${reservation.end_time} was cancelled because the resource availability changed. ${requiredCredits} credits were refunded.`,
      ],
    );
  }
  return affected.rows.length;
}

export async function listOwnedResources(client: DatabaseClient, ownerId: number): Promise<ListingSummary[]> {
  const result = await client.query<{
    resource_id: number;
    name: string;
    description: string;
    capacity: number;
    category_id: number;
    category_name: string;
    building_id: number;
    building_name: string;
    image_id: number | null;
    average_rating: number | string | null;
    review_count: number | string;
    active_start: string | null;
    active_end: string | null;
  }>(
    `
      SELECT
        r.resource_id,
        r.name,
        r.description,
        r.capacity,
        c.category_id,
        c.category_name,
        b.building_id,
        b.building_name,
        img.image_id,
        rating.average_rating,
        COALESCE(rating.review_count, 0) AS review_count,
        ${localTimestampSql("active.start_time")} AS active_start,
        ${localTimestampSql("active.end_time")} AS active_end
      FROM "Resource" AS r
      JOIN "ResourceCategory" AS c ON c.category_id = r.category_id
      JOIN "Building" AS b ON b.building_id = r.building_id
      LEFT JOIN "ImageMetadata" AS img ON img.image_id = r.resource_image_id
      LEFT JOIN (
        SELECT resource_id, ROUND(AVG(rating)::numeric, 2)::float8 AS average_rating, COUNT(*)::integer AS review_count
        FROM "ResourceReview"
        GROUP BY resource_id
      ) AS rating ON rating.resource_id = r.resource_id
      LEFT JOIN LATERAL (
        SELECT start_time, end_time
        FROM "Reservation"
        WHERE resource_id = r.resource_id
          AND status = 'confirmed'
          AND start_time <= ${CAMPUS_NOW_SQL}
          AND end_time > ${CAMPUS_NOW_SQL}
        ORDER BY start_time, reservation_id
        LIMIT 1
      ) AS active ON TRUE
      WHERE r.owner_id = $1
      ORDER BY r.name, r.resource_id
    `,
    [ownerId],
  );

  return result.rows.map((row) => ({
    id: row.resource_id,
    name: row.name,
    category: { id: row.category_id, name: row.category_name },
    building: { id: row.building_id, name: row.building_name },
    capacity: row.capacity,
    shortDescription: shortenDescription(row.description),
    averageRating: row.average_rating === null ? null : Number(row.average_rating),
    reviewCount: Number(row.review_count),
    thumbnailUrl: row.image_id === null ? null : `/api/resource-images/${row.image_id}`,
    hasActiveReservation: row.active_start !== null,
    activeReservation: row.active_start && row.active_end
      ? { startTime: row.active_start, endTime: row.active_end }
      : null,
  }));
}

export async function getOwnedResource(
  client: DatabaseClient,
  resourceId: number,
  ownerId: number,
): Promise<ListingResult<ListingDetails>> {
  const ownership = await ownedResource(client, resourceId, ownerId, false);
  if (!ownership.ok) return ownership;
  const details = await getResourceDetails(client, resourceId);
  if (!details) return fail(404, "Resource not found.");
  const availability = await getOwnedAvailability(client, resourceId);
  return {
    ok: true,
    value: {
      ...details,
      hasActiveReservation: ownership.value.active !== null,
      activeReservation: ownership.value.active,
      availability,
    },
  };
}

async function saveImageMetadata(
  client: DatabaseClient,
  resourceId: number,
  file: File,
  key: string,
): Promise<number> {
  const result = await client.query<{ image_id: number }>(
    `
      INSERT INTO "ImageMetadata" (object_key, content_type, size, width, height, alt_text, status, filename)
      VALUES ($1, $2, $3, 0, 0, NULL, 'ready', $4)
      RETURNING image_id
    `,
    [key, file.type, file.size, file.name],
  );
  await client.query(`UPDATE "Resource" SET resource_image_id = $1 WHERE resource_id = $2`, [result.rows[0].image_id, resourceId]);
  return result.rows[0].image_id;
}

export async function createListing(
  client: DatabaseClient,
  bucket: R2Bucket | undefined,
  ownerId: number,
  input: ListingInput,
): Promise<ListingResult<ListingDetails>> {
  let uploadedKey: string | null = null;
  let committed = false;
  await client.query("BEGIN");
  try {
    const referenceError = await verifyReferences(client, input.buildingId, input.categoryId);
    if (referenceError) {
      await client.query("ROLLBACK");
      return fail(400, referenceError);
    }

    const inserted = await client.query<{ resource_id: number }>(
      `
        INSERT INTO "Resource" (
          owner_id, building_id, category_id, name, description, location_description,
          max_reservation_time, required_credits, capacity
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::interval, $8, $9)
        RETURNING resource_id
      `,
      [ownerId, input.buildingId, input.categoryId, input.name, input.description, input.locationDescription,
        intervalValue(input.maxReservationMinutes), input.requiredCredits, input.capacity],
    );
    const resourceId = inserted.rows[0].resource_id;

    await insertAvailability(client, resourceId, input.availability);
    const availabilityError = await validateAvailabilitySet(client, resourceId);
    if (availabilityError) {
      await client.query("ROLLBACK");
      return fail(400, availabilityError);
    }

    if (input.image) {
      uploadedKey = objectKey(ownerId, resourceId, input.image);
      const uploaded = await uploadImage(bucket, input.image, uploadedKey);
      if (!uploaded.ok) {
        await client.query("ROLLBACK");
        await bestEffortDelete(bucket, uploadedKey);
        return uploaded;
      }
      await saveImageMetadata(client, resourceId, input.image, uploadedKey);
    }

    await client.query("COMMIT");
    committed = true;
    const details = await getOwnedResource(client, resourceId, ownerId);
    return details;
  } catch {
    if (!committed) await client.query("ROLLBACK");
    await bestEffortDelete(bucket, uploadedKey);
    throw new Error("Unable to create the listing right now.");
  }
}

export async function updateListing(
  client: DatabaseClient,
  bucket: R2Bucket | undefined,
  ownerId: number,
  resourceId: number,
  input: ListingInput,
): Promise<ListingResult<ListingDetails>> {
  let uploadedKey: string | null = null;
  let oldObjectKey: string | null = null;
  let committed = false;
  await client.query("BEGIN");
  try {
    const owned = await ownedResource(client, resourceId, ownerId, true);
    if (!owned.ok) {
      await client.query("ROLLBACK");
      return owned;
    }
    if (owned.value.active) {
      await client.query("ROLLBACK");
      return fail(409, activeMessage(owned.value.active));
    }

    const referenceError = await verifyReferences(client, input.buildingId, input.categoryId);
    if (referenceError) {
      await client.query("ROLLBACK");
      return fail(400, referenceError);
    }

    if (input.availability !== null) {
      await client.query(`DELETE FROM "ResourceAvailability" WHERE resource_id = $1`, [resourceId]);
      await insertAvailability(client, resourceId, input.availability);
      const availabilityError = await validateAvailabilitySet(client, resourceId);
      if (availabilityError) {
        await client.query("ROLLBACK");
        return fail(400, availabilityError);
      }
      await cancelAffectedReservations(client, resourceId, input.name, owned.value.requiredCredits);
    }

    await client.query(
      `
        UPDATE "Resource"
        SET building_id = $2, category_id = $3, name = $4, description = $5,
            location_description = $6, max_reservation_time = $7::interval,
            required_credits = $8, capacity = $9
        WHERE resource_id = $1 AND owner_id = $10
      `,
      [resourceId, input.buildingId, input.categoryId, input.name, input.description, input.locationDescription,
        intervalValue(input.maxReservationMinutes), input.requiredCredits, input.capacity, ownerId],
    );

    if (input.image || input.removeImage) {
      oldObjectKey = owned.value.objectKey;
      if (input.image) {
        uploadedKey = objectKey(ownerId, resourceId, input.image);
        const uploaded = await uploadImage(bucket, input.image, uploadedKey);
        if (!uploaded.ok) {
          await client.query("ROLLBACK");
          await bestEffortDelete(bucket, uploadedKey);
          return uploaded;
        }
        await saveImageMetadata(client, resourceId, input.image, uploadedKey);
      } else {
        await client.query(`UPDATE "Resource" SET resource_image_id = NULL WHERE resource_id = $1`, [resourceId]);
      }
      if (owned.value.imageId !== null) {
        await client.query(`DELETE FROM "ImageMetadata" WHERE image_id = $1`, [owned.value.imageId]);
      }
    }

    await client.query("COMMIT");
    committed = true;
    await bestEffortDelete(bucket, oldObjectKey);
    return getOwnedResource(client, resourceId, ownerId);
  } catch {
    if (!committed) await client.query("ROLLBACK");
    await bestEffortDelete(bucket, uploadedKey);
    throw new Error("Unable to update the listing right now.");
  }
}

export async function deleteListing(
  client: DatabaseClient,
  bucket: R2Bucket | undefined,
  ownerId: number,
  resourceId: number,
): Promise<ListingResult<null>> {
  await client.query("BEGIN");
  try {
    const owned = await ownedResource(client, resourceId, ownerId, true);
    if (!owned.ok) {
      await client.query("ROLLBACK");
      return owned;
    }
    if (owned.value.active) {
      await client.query("ROLLBACK");
      return fail(409, activeMessage(owned.value.active));
    }
    if (owned.value.objectKey) {
      if (!bucket) {
        await client.query("ROLLBACK");
        return fail(503, "Image storage is not configured right now.");
      }
      await bucket.delete(owned.value.objectKey);
    }

    await client.query(`DELETE FROM "Resource" WHERE resource_id = $1 AND owner_id = $2`, [resourceId, ownerId]);
    if (owned.value.imageId !== null) {
      await client.query(`DELETE FROM "ImageMetadata" WHERE image_id = $1`, [owned.value.imageId]);
    }
    await client.query("COMMIT");
    return { ok: true, value: null };
  } catch {
    await client.query("ROLLBACK");
    throw new Error("Unable to delete the listing right now.");
  }
}

export async function getImageMetadata(
  client: DatabaseClient,
  imageId: number,
): Promise<{ objectKey: string; contentType: string; filename: string } | null> {
  const result = await client.query<{ object_key: string; content_type: string; filename: string }>(
    `SELECT object_key, content_type, filename FROM "ImageMetadata" WHERE image_id = $1`,
    [imageId],
  );
  const row = result.rows[0];
  return row ? { objectKey: row.object_key, contentType: row.content_type, filename: row.filename } : null;
}
