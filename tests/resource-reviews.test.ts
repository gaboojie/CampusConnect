import { describe, expect, it } from "vitest";
import { createApp } from "../backend/index";
import { parseResourceReviewInput } from "../db/repositories/resourceReviews";
import { FakeReadDatabase, authHeaders } from "./support/fakeReadDatabase";

const finishedReservation = {
  reservation_id: 41,
  status: "completed",
  start_time: "2026-10-20T10:00:00",
  end_time: "2026-10-20T11:00:00",
  resource_id: 12,
  resource_name: "Quiet study room",
  existing_review: false,
  is_finished: true,
};

describe("resource review input", () => {
  it("accepts a rating, optional reason, and anonymity choice", () => {
    expect(parseResourceReviewInput({
      rating: 5,
      reason: "Everything was ready.",
      isAnonymous: true,
    })).toEqual({
      ok: true,
      value: {
        rating: 5,
        reason: "Everything was ready.",
        isAnonymous: true,
      },
    });
  });

  it.each([
    [{ rating: 0, isAnonymous: false }, /1 to 5/],
    [{ rating: 6, isAnonymous: false }, /1 to 5/],
    [{ rating: 4, isAnonymous: false, reason: "x".repeat(501) }, /500/],
    [{ rating: 4, isAnonymous: "yes" }, /anonymous/],
  ])("rejects invalid review input", (body, message) => {
    const result = parseResourceReviewInput(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });
});

describe("resource review endpoint", () => {
  it("requires a session", async () => {
    const database = new FakeReadDatabase();
    const app = createApp({ createDatabaseClient: () => database.createClient() });

    const response = await app.request(
      "http://localhost/api/reservations/41/resource-review",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rating: 5, isAnonymous: false }),
      },
      database.environment(),
    );

    expect(response.status).toBe(401);
  });

  it("creates a review for the signed-in user's finished reservation", async () => {
    const database = new FakeReadDatabase()
      .respond((query) => query.startsWith("SELECT reservation.reservation_id"), [finishedReservation])
      .respond("INSERT INTO \"ResourceReview\"", [{
        review_id: 72,
        rating: 5,
        reason: "Everything was ready.",
        created_at: "2026-10-20T11:30:00",
        is_anonymous_review: false,
      }]);
    const app = createApp({ createDatabaseClient: () => database.createClient() });

    const response = await app.request(
      "http://localhost/api/reservations/41/resource-review",
      {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ rating: 5, reason: "Everything was ready.", isAnonymous: false }),
      },
      database.environment(),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      review: {
        id: 72,
        reservationId: 41,
        rating: 5,
        reason: "Everything was ready.",
        createdAt: "2026-10-20T11:30:00",
        isAnonymous: false,
        resource: { id: 12, name: "Quiet study room" },
      },
    });
    const insert = database.queries.find((query) => query.text.startsWith("INSERT INTO \"ResourceReview\""));
    expect(insert?.values).toEqual([41, 12, 6, 5, "Everything was ready.", false]);
  });

  it("rejects reservations that are not finished or already reviewed", async () => {
    const database = new FakeReadDatabase()
      .respond((query) => query.startsWith("SELECT reservation.reservation_id"), [{
        ...finishedReservation,
        status: "confirmed",
        is_finished: false,
        existing_review: true,
      }]);
    const app = createApp({ createDatabaseClient: () => database.createClient() });

    const response = await app.request(
      "http://localhost/api/reservations/41/resource-review",
      {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ rating: 4, isAnonymous: false }),
      },
      database.environment(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Only finished reservations can be reviewed." });
  });

  it("rejects a second review for the same reservation", async () => {
    const database = new FakeReadDatabase()
      .respond((query) => query.startsWith("SELECT reservation.reservation_id"), [{
        ...finishedReservation,
        existing_review: true,
      }]);
    const app = createApp({ createDatabaseClient: () => database.createClient() });

    const response = await app.request(
      "http://localhost/api/reservations/41/resource-review",
      {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ rating: 4, isAnonymous: false }),
      },
      database.environment(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "This reservation has already been reviewed." });
  });
});
