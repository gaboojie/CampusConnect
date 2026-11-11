import type { DatabaseClient } from "../client";
import { CAMPUS_NOW_SQL, parsePositiveId, type Validation } from "./resources";

const REVIEW_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;
const MAX_REASON_LENGTH = 500;

export type ReservationReviewInput = {
  reservationId: number;
  rating: number;
  reason: string | null;
  isAnonymous: boolean;
};

export type ReviewServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404 | 409; error: string };

export type OwnerReservationReview = {
  reservationId: number;
  reserver: { id: number; username: string };
  startTime: string;
  endTime: string;
  review: {
    rating: number;
    reason: string | null;
    createdAt: string;
    isAnonymous: boolean;
  } | null;
};

export type UserReviewItem = {
  id: number;
  reservationId: number;
  rating: number;
  reason: string | null;
  createdAt: string;
  resource: { id: number; name: string };
  reviewer: { id: number; username: string } | null;
};

export type UserReviewPage = {
  profile: { id: number; username: string };
  items: UserReviewItem[];
  total: number;
  page: number;
  pageSize: number;
  averageRating: number | null;
};

export type ReviewPageQuery = { page: number; pageSize: number };

function fail<T>(status: 400 | 404 | 409, error: string): ReviewServiceResult<T> {
  return { ok: false, status, error };
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseReservationReviewInput(body: unknown): Validation<ReservationReviewInput> {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Review details are required." };
  }

  const input = body as Record<string, unknown>;
  const reservationId = numberValue(input.reservationId);
  const rating = numberValue(input.rating);
  const reasonValue = input.reason;
  const reason = reasonValue === null || reasonValue === undefined ? "" : textValue(reasonValue);
  const isAnonymous = input.isAnonymous;

  if (reservationId === null || !Number.isInteger(reservationId) || parsePositiveId(String(reservationId)) === null) {
    return { ok: false, error: "Reservation id must be a positive whole number." };
  }
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
    value: {
      reservationId,
      rating,
      reason: reason || null,
      isAnonymous,
    },
  };
}

export function parseReviewPageQuery(params: URLSearchParams): Validation<ReviewPageQuery> {
  const pageRaw = (params.get("page") ?? "").trim();
  const pageSizeRaw = (params.get("pageSize") ?? "").trim();

  if (pageRaw && (!/^\d+$/.test(pageRaw) || Number(pageRaw) < 1)) {
    return { ok: false, error: "Page must be a positive whole number." };
  }
  if (pageSizeRaw && (!/^\d+$/.test(pageSizeRaw) || Number(pageSizeRaw) < 1)) {
    return { ok: false, error: "Page size must be a positive whole number." };
  }

  return {
    ok: true,
    value: {
      page: pageRaw ? Number(pageRaw) : 1,
      pageSize: pageSizeRaw ? Math.min(Number(pageSizeRaw), MAX_PAGE_SIZE) : REVIEW_PAGE_SIZE,
    },
  };
}

function toOwnerReview(row: {
  reservation_id: number;
  reserver_id: number;
  reserver_username: string;
  start_time: string;
  end_time: string;
  review_rating: number | null;
  review_reason: string | null;
  review_created_at: string | null;
  review_is_anonymous: boolean | null;
}): OwnerReservationReview {
  return {
    reservationId: row.reservation_id,
    reserver: { id: row.reserver_id, username: row.reserver_username },
    startTime: row.start_time,
    endTime: row.end_time,
    review: row.review_rating === null
      ? null
      : {
          rating: row.review_rating,
          reason: row.review_reason,
          createdAt: row.review_created_at!,
          isAnonymous: row.review_is_anonymous === true,
        },
  };
}

export async function listOwnerReservationReviews(
  client: DatabaseClient,
  resourceId: number,
  ownerId: number,
): Promise<ReviewServiceResult<OwnerReservationReview[]>> {
  const ownership = await client.query<{ resource_id: number }>(
    `SELECT resource_id FROM "Resource" WHERE resource_id = $1 AND owner_id = $2`,
    [resourceId, ownerId],
  );
  if (ownership.rows.length === 0) return fail(404, "Listing not found.");

  const result = await client.query<{
    reservation_id: number;
    reserver_id: number;
    reserver_username: string;
    start_time: string;
    end_time: string;
    review_rating: number | null;
    review_reason: string | null;
    review_created_at: string | null;
    review_is_anonymous: boolean | null;
  }>(
    `
      SELECT
        r.reservation_id,
        reserver.user_id AS reserver_id,
        reserver.username AS reserver_username,
        to_char(r.start_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_time,
        to_char(r.end_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS end_time,
        rr.rating AS review_rating,
        rr.reason AS review_reason,
        to_char(rr.created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS review_created_at,
        rr.is_anonymous_review AS review_is_anonymous
      FROM "Reservation" AS r
      JOIN "User" AS reserver ON reserver.user_id = r.user_id
      LEFT JOIN "ReservationReview" AS rr ON rr.reservation_id = r.reservation_id
      WHERE r.resource_id = $1
        AND r.status = 'completed'
        AND r.user_id <> $2
        AND r.end_time > ${CAMPUS_NOW_SQL} - interval '7 days'
        AND r.end_time <= ${CAMPUS_NOW_SQL}
      ORDER BY r.end_time DESC, r.reservation_id DESC
    `,
    [resourceId, ownerId],
  );

  return { ok: true, value: result.rows.map(toOwnerReview) };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export async function createReservationReview(
  client: DatabaseClient,
  resourceId: number,
  ownerId: number,
  input: ReservationReviewInput,
): Promise<ReviewServiceResult<OwnerReservationReview>> {
  const reservation = await client.query<{
    reservation_id: number;
    reserver_id: number;
    reserver_username: string;
    status: string;
    start_time: string;
    end_time: string;
    is_in_window: boolean;
    existing_review: boolean;
  }>(
    `
      SELECT
        r.reservation_id,
        reserver.user_id AS reserver_id,
        reserver.username AS reserver_username,
        r.status,
        to_char(r.start_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_time,
        to_char(r.end_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS end_time,
        (r.end_time > ${CAMPUS_NOW_SQL} - interval '7 days' AND r.end_time <= ${CAMPUS_NOW_SQL}) AS is_in_window,
        EXISTS (SELECT 1 FROM "ReservationReview" AS existing WHERE existing.reservation_id = r.reservation_id) AS existing_review
      FROM "Resource" AS resource
      JOIN "Reservation" AS r ON r.resource_id = resource.resource_id
      JOIN "User" AS reserver ON reserver.user_id = r.user_id
      WHERE resource.resource_id = $1
        AND resource.owner_id = $2
        AND r.reservation_id = $3
    `,
    [resourceId, ownerId, input.reservationId],
  );

  const row = reservation.rows[0];
  if (!row) return fail(404, "Listing or reservation not found.");
  if (row.reserver_id === ownerId) return fail(409, "You cannot review your own reservation.");
  if (row.status !== "completed" || !row.is_in_window) {
    return fail(409, "Only completed reservations from the past seven days can be reviewed.");
  }
  if (row.existing_review) return fail(409, "This reservation has already been reviewed.");

  try {
    const inserted = await client.query<{
      rating: number;
      reason: string | null;
      created_at: string;
      is_anonymous_review: boolean;
    }>(
      `
        INSERT INTO "ReservationReview" (
          reservation_id, reviewer_user_id, reviewee_user_id, rating, reason, is_anonymous_review
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING rating, reason, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at, is_anonymous_review
      `,
      [input.reservationId, ownerId, row.reserver_id, input.rating, input.reason, input.isAnonymous],
    );
    const review = inserted.rows[0];
    return {
      ok: true,
      value: {
        reservationId: input.reservationId,
        reserver: { id: row.reserver_id, username: row.reserver_username },
        startTime: row.start_time,
        endTime: row.end_time,
        review: {
          rating: review.rating,
          reason: review.reason,
          createdAt: review.created_at,
          isAnonymous: review.is_anonymous_review,
        },
      },
    };
  } catch (error) {
    if (isUniqueViolation(error)) return fail(409, "This reservation has already been reviewed.");
    throw error;
  }
}

export async function listUserReservationReviews(
  client: DatabaseClient,
  userId: number,
  query: ReviewPageQuery,
): Promise<UserReviewPage | null> {
  const profile = await client.query<{
    user_id: number;
    username: string;
    total: number | string;
    average_rating: number | string | null;
  }>(
    `
      SELECT
        u.user_id,
        u.username,
        COUNT(rr.reservation_id)::integer AS total,
        ROUND(AVG(rr.rating)::numeric, 2)::float8 AS average_rating
      FROM "User" AS u
      LEFT JOIN "ReservationReview" AS rr ON rr.reviewee_user_id = u.user_id
      WHERE u.user_id = $1
      GROUP BY u.user_id, u.username
    `,
    [userId],
  );
  const profileRow = profile.rows[0];
  if (!profileRow) return null;

  const reviews = await client.query<{
    review_id: number;
    reservation_id: number;
    rating: number;
    reason: string | null;
    created_at: string;
    resource_id: number;
    resource_name: string;
    reviewer_id: number | null;
    reviewer_username: string | null;
    total: number | string;
  }>(
    `
      SELECT
        rr.reservation_id AS review_id,
        rr.reservation_id,
        rr.rating,
        rr.reason,
        to_char(rr.created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
        resource.resource_id,
        resource.name AS resource_name,
        CASE WHEN rr.is_anonymous_review THEN NULL ELSE reviewer.user_id END AS reviewer_id,
        CASE WHEN rr.is_anonymous_review THEN NULL ELSE reviewer.username END AS reviewer_username,
        COUNT(*) OVER()::integer AS total
      FROM "ReservationReview" AS rr
      JOIN "Reservation" AS reservation ON reservation.reservation_id = rr.reservation_id
      JOIN "Resource" AS resource ON resource.resource_id = reservation.resource_id
      JOIN "User" AS reviewer ON reviewer.user_id = rr.reviewer_user_id
      WHERE rr.reviewee_user_id = $1
      ORDER BY rr.created_at DESC, rr.reservation_id DESC
      LIMIT $2 OFFSET $3
    `,
    [userId, query.pageSize, (query.page - 1) * query.pageSize],
  );

  return {
    profile: { id: profileRow.user_id, username: profileRow.username },
    items: reviews.rows.map((row) => ({
      id: row.review_id,
      reservationId: row.reservation_id,
      rating: row.rating,
      reason: row.reason,
      createdAt: row.created_at,
      resource: { id: row.resource_id, name: row.resource_name },
      reviewer: row.reviewer_id === null || row.reviewer_username === null
        ? null
        : { id: row.reviewer_id, username: row.reviewer_username },
    })),
    total: Number(reviews.rows[0]?.total ?? profileRow.total ?? 0),
    page: query.page,
    pageSize: query.pageSize,
    averageRating: profileRow.average_rating === null ? null : Number(profileRow.average_rating),
  };
}
