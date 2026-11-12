import { describe, expect, it } from "vitest";
import { createApp } from "../backend/index";
import {
  parseUserReviewInput,
  parseReviewPageQuery,
} from "../db/repositories/reservationReviews";
import { FakeReadDatabase, authHeaders } from "./support/fakeReadDatabase";

const ownerReservation = {
  reservation_id: 41,
  reserver_id: 12,
  reserver_username: "liam_k",
  start_time: "2026-10-20T10:00:00",
  end_time: "2026-10-20T11:00:00",
  review_rating: null,
  review_reason: null,
  review_created_at: null,
  review_is_anonymous: null,
};

describe("reservation review input", () => {
  it("accepts a rating, optional reason, and anonymity choice", () => {
    expect(parseUserReviewInput({
      reservationId: 41,
      rating: 5,
      reason: "Everything was ready.",
      isAnonymous: true,
    })).toEqual({
      ok: true,
      value: {
        reservationId: 41,
        rating: 5,
        reason: "Everything was ready.",
        isAnonymous: true,
      },
    });
  });

  it.each([
    [{ reservationId: 41, rating: 0, isAnonymous: false }, /1 to 5/],
    [{ reservationId: 41, rating: 6, isAnonymous: false }, /1 to 5/],
    [{ reservationId: 41, rating: 4, isAnonymous: false, reason: "x".repeat(501) }, /500/],
    [{ reservationId: 41, rating: 4, isAnonymous: "yes" }, /anonymous/],
  ])("rejects invalid review input", (body, message) => {
    const result = parseUserReviewInput(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });

  it("defaults page size to ten and clamps oversized page sizes", () => {
    expect(parseReviewPageQuery(new URLSearchParams("page=2"))).toEqual({
      ok: true,
      value: { page: 2, pageSize: 10 },
    });
    expect(parseReviewPageQuery(new URLSearchParams("pageSize=1000"))).toEqual({
      ok: true,
      value: { page: 1, pageSize: 100 },
    });
  });
});

describe("reservation review endpoints", () => {
  it.each([
    ["GET", "/api/listings/12/reservation-reviews"],
    ["POST", "/api/listings/12/reservation-reviews"],
    ["GET", "/api/users/12/reviews"],
  ])("requires a session for %s %s", async (method, path) => {
    const database = new FakeReadDatabase();
    const app = createApp({ createDatabaseClient: () => database.createClient() });
    const response = await app.request(`http://localhost${path}`, {
      method,
      headers: method === "POST" ? { "content-type": "application/json" } : {},
      body: method === "POST" ? JSON.stringify({ reservationId: 41, rating: 5, isAnonymous: false }) : undefined,
    }, database.environment());
    expect(response.status).toBe(401);
  });

  it("lists only the owner's completed reservations from the rolling review window", async () => {
    const database = new FakeReadDatabase()
      .respond("SELECT resource_id FROM \"Resource\"", [{ resource_id: 12 }])
      .respond("SELECT r.reservation_id", [ownerReservation]);
    const app = createApp({ createDatabaseClient: () => database.createClient() });

    const response = await app.request(
      "http://localhost/api/listings/12/reservation-reviews",
      { headers: authHeaders },
      database.environment(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      reservations: [{
        reservationId: 41,
        reserver: { id: 12, username: "liam_k" },
        startTime: "2026-10-20T10:00:00",
        endTime: "2026-10-20T11:00:00",
        review: null,
      }],
    });
    const queueQuery = database.queries.find((query) => query.text.startsWith("SELECT r.reservation_id"));
    expect(queueQuery?.text).toContain("r.status = 'completed'");
    expect(queueQuery?.text).toContain("interval '7 days'");
    expect(queueQuery?.text).toContain("r.user_id <> $2");
    expect(queueQuery?.values).toEqual([12, 6]);
  });

  it("rejects a review queue for a resource the user does not own", async () => {
    const database = new FakeReadDatabase().respond("SELECT resource_id FROM \"Resource\"", []);
    const app = createApp({ createDatabaseClient: () => database.createClient() });

    const response = await app.request(
      "http://localhost/api/listings/99/reservation-reviews",
      { headers: authHeaders },
      database.environment(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Listing not found." });
  });

  it("creates an owner-to-reserver review and preserves the reviewed state", async () => {
    const database = new FakeReadDatabase()
      .respond("SELECT r.reservation_id", [{
        reservation_id: 41,
        reserver_id: 12,
        reserver_username: "liam_k",
        status: "completed",
        start_time: "2026-10-20T10:00:00",
        end_time: "2026-10-20T11:00:00",
        is_in_window: true,
        existing_review: false,
      }])
      .respond("INSERT INTO \"UserReview\"", [{
        rating: 4,
        reason: "Returned everything in good condition.",
        created_at: "2026-10-20T11:30:00",
        is_anonymous_review: true,
      }]);
    const app = createApp({ createDatabaseClient: () => database.createClient() });

    const response = await app.request(
      "http://localhost/api/listings/12/reservation-reviews",
      {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          reservationId: 41,
          rating: 4,
          reason: "Returned everything in good condition.",
          isAnonymous: true,
        }),
      },
      database.environment(),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      reservation: {
        reservationId: 41,
        reserver: { id: 12, username: "liam_k" },
        startTime: "2026-10-20T10:00:00",
        endTime: "2026-10-20T11:00:00",
        review: {
          rating: 4,
          reason: "Returned everything in good condition.",
          createdAt: "2026-10-20T11:30:00",
          isAnonymous: true,
        },
      },
    });
    const insert = database.queries.find((query) => query.text.startsWith("INSERT INTO \"UserReview\""));
    expect(insert?.values).toEqual([41, 6, 12, 4, "Returned everything in good condition.", true]);
  });

  it("rejects a duplicate, stale, or non-completed reservation", async () => {
    const database = new FakeReadDatabase()
      .respond("SELECT r.reservation_id", [{
        reservation_id: 41,
        reserver_id: 12,
        reserver_username: "liam_k",
        status: "confirmed",
        start_time: "2026-10-01T10:00:00",
        end_time: "2026-10-01T11:00:00",
        is_in_window: false,
        existing_review: true,
      }]);
    const app = createApp({ createDatabaseClient: () => database.createClient() });

    const response = await app.request(
      "http://localhost/api/listings/12/reservation-reviews",
      {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ reservationId: 41, rating: 5, isAnonymous: false }),
      },
      database.environment(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Only completed reservations from the past seven days can be reviewed." });
  });

  it("returns paginated user reviews and hides anonymous reviewer identity", async () => {
    const database = new FakeReadDatabase()
      .respond("SELECT u.user_id, u.username", [{ user_id: 12, username: "liam_k", total: 2, average_rating: 4.5 }])
      .respond("SELECT rr.reservation_id", [
        {
          review_id: 41,
          reservation_id: 41,
          rating: 5,
          reason: "Great communication.",
          created_at: "2026-10-20T11:30:00",
          resource_id: 12,
          resource_name: "Quiet study room",
          reviewer_id: 6,
          reviewer_username: "maya_r",
          total: 2,
        },
        {
          review_id: 40,
          reservation_id: 40,
          rating: 4,
          reason: null,
          created_at: "2026-10-18T12:00:00",
          resource_id: 13,
          resource_name: "Project room",
          reviewer_id: null,
          reviewer_username: null,
          total: 2,
        },
      ]);
    const app = createApp({ createDatabaseClient: () => database.createClient() });

    const response = await app.request(
      "http://localhost/api/users/12/reviews?page=2&pageSize=10",
      { headers: authHeaders },
      database.environment(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      profile: { id: 12, username: "liam_k" },
      items: [
        {
          id: 41,
          reservationId: 41,
          rating: 5,
          reason: "Great communication.",
          createdAt: "2026-10-20T11:30:00",
          resource: { id: 12, name: "Quiet study room" },
          reviewer: { id: 6, username: "maya_r" },
        },
        {
          id: 40,
          reservationId: 40,
          rating: 4,
          reason: null,
          createdAt: "2026-10-18T12:00:00",
          resource: { id: 13, name: "Project room" },
          reviewer: null,
        },
      ],
      total: 2,
      page: 2,
      pageSize: 10,
      averageRating: 4.5,
    });
    const reviewQuery = database.queries.find((query) => query.text.startsWith("SELECT rr.reservation_id"));
    expect(reviewQuery?.values).toEqual([12, 10, 10]);
    expect(reviewQuery?.text).toContain("CASE WHEN rr.is_anonymous_review THEN NULL ELSE reviewer.username END");
  });
});
