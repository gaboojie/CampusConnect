import type { DatabaseClient } from "../client";
import { CAMPUS_NOW_SQL, type Validation } from "./resources";
import { markReviewNotificationRead, RESOURCE_REVIEW_DUE_NOTIFICATION } from "./notifications";

const MAX_REASON_LENGTH = 500;

export type ResourceReviewInput = {
  rating: number;
  reason: string | null;
  isAnonymous: boolean;
};

export type ResourceReview = {
  id: number;
  reservationId: number;
  rating: number;
  reason: string | null;
  createdAt: string;
  isAnonymous: boolean;
  resource: { id: number; name: string };
};

export type ResourceReviewResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404 | 409; error: string };

function fail<T>(status: 400 | 404 | 409, error: string): ResourceReviewResult<T> {
  return { ok: false, status, error };
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseResourceReviewInput(body: unknown): Validation<ResourceReviewInput> {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Review details are required." };
  }

  const input = body as Record<string, unknown>;
  const rating = numberValue(input.rating);
  const reasonValue = input.reason;
  const reason = reasonValue === null || reasonValue === undefined ? "" : textValue(reasonValue);
  const isAnonymous = input.isAnonymous;

  if (rating === null || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, error: "Rating must be a whole number from 1 to 5." };
  }
  if (reason.length > MAX_REASON_LENGTH) {
    return { ok: false, error: `Review reason must be ${MAX_REASON_LENGTH} characters or fewer.` };
  }
  if (typeof isAnonymous !== "boolean") {
    return { ok: false, error: "Choose whether this review should be anonymous." };
  }

  return {
    ok: true,
    value: { rating, reason: reason || null, isAnonymous },
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export async function createResourceReview(
  client: DatabaseClient,
  userId: number,
  reservationId: number,
  input: ResourceReviewInput,
): Promise<ResourceReviewResult<ResourceReview>> {
  const reservation = await client.query<{
    reservation_id: number;
    status: string;
    start_time: string;
    end_time: string;
    resource_id: number;
    resource_name: string;
    existing_review: boolean;
    is_finished: boolean;
  }>(
    `
      SELECT
        reservation.reservation_id,
        reservation.status,
        to_char(reservation.start_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_time,
        to_char(reservation.end_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS end_time,
        resource.resource_id,
        resource.name AS resource_name,
        (reservation.end_time <= ${CAMPUS_NOW_SQL}) AS is_finished,
        EXISTS (
          SELECT 1
          FROM "ResourceReview" AS existing
          WHERE existing.reservation_id = reservation.reservation_id
        ) AS existing_review
      FROM "Reservation" AS reservation
      JOIN "Resource" AS resource ON resource.resource_id = reservation.resource_id
      WHERE reservation.reservation_id = $1
        AND reservation.user_id = $2
    `,
    [reservationId, userId],
  );

  const row = reservation.rows[0];
  if (!row) return fail(404, "Reservation not found.");
  if (row.status !== "confirmed" && row.status !== "completed") {
    return fail(409, "Only finished reservations can be reviewed.");
  }
  if (!row.is_finished) return fail(409, "Only finished reservations can be reviewed.");
  if (row.existing_review) return fail(409, "This reservation has already been reviewed.");

  try {
    const inserted = await client.query<{
      review_id: number;
      rating: number;
      reason: string | null;
      created_at: string;
      is_anonymous_review: boolean;
    }>(
      `
        INSERT INTO "ResourceReview" (
          reservation_id, resource_id, reviewer_user_id, rating, reason, is_anonymous_review
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING
          review_id,
          rating,
          reason,
          to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
          is_anonymous_review
      `,
      [reservationId, row.resource_id, userId, input.rating, input.reason, input.isAnonymous],
    );
    const review = inserted.rows[0];
    await markReviewNotificationRead(client, {
      userId,
      reservationId,
      notificationType: RESOURCE_REVIEW_DUE_NOTIFICATION,
    });

    return {
      ok: true,
      value: {
        id: review.review_id,
        reservationId,
        rating: review.rating,
        reason: review.reason,
        createdAt: review.created_at,
        isAnonymous: review.is_anonymous_review,
        resource: { id: row.resource_id, name: row.resource_name },
      },
    };
  } catch (error) {
    if (isUniqueViolation(error)) return fail(409, "This reservation has already been reviewed.");
    throw error;
  }
}
