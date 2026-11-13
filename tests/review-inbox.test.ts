import { describe, expect, it } from "vitest";
import { createApp } from "../backend/index";
import { FakeReadDatabase, authHeaders, expectReadOnly } from "./support/fakeReadDatabase";

const resourceTask = {
  reservation_id: 41,
  status: "completed",
  start_time: "2026-10-20T10:00:00",
  end_time: "2026-10-20T11:00:00",
  created_at: "2026-10-19T09:00:00",
  resource_id: 12,
  resource_name: "Quiet study room",
  building_id: 2,
  building_name: "Newman Library",
};

const userTask = {
  reservation_id: 42,
  resource_id: 13,
  resource_name: "Project room",
  building_id: 3,
  building_name: "Torgersen Hall",
  reserver_id: 12,
  reserver_username: "liam_k",
  start_time: "2026-10-21T10:00:00",
  end_time: "2026-10-21T11:00:00",
};

function setup() {
  const database = new FakeReadDatabase()
    .respond(
      (query) => query.startsWith("SELECT rv.reservation_id") && query.includes("rv.user_id = $1"),
      [resourceTask],
    )
    .respond(
      (query) => query.startsWith("SELECT rv.reservation_id") && query.includes("resource.owner_id = $1"),
      [userTask],
    );
  const app = createApp({ createDatabaseClient: () => database.createClient() });
  return { database, app };
}

describe("GET /api/reviews/mine", () => {
  it("requires a session", async () => {
    const { database, app } = setup();
    const response = await app.request("http://localhost/api/reviews/mine", {}, database.environment());

    expect(response.status).toBe(401);
    expect(database.queries).toEqual([]);
  });

  it("returns actionable resource and reservation review tasks", async () => {
    const { database, app } = setup();
    const response = await app.request(
      "http://localhost/api/reviews/mine",
      { headers: authHeaders },
      database.environment(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resourceReviews: [{
        id: 41,
        resource: { id: 12, name: "Quiet study room" },
        building: { id: 2, name: "Newman Library" },
        startTime: "2026-10-20T10:00:00",
        endTime: "2026-10-20T11:00:00",
        status: "completed",
        createdAt: "2026-10-19T09:00:00",
        canModify: false,
        creditsCharged: null,
        refundEligible: false,
        canReviewResource: true,
      }],
      userReviews: [{
        reservationId: 42,
        resource: { id: 13, name: "Project room" },
        building: { id: 3, name: "Torgersen Hall" },
        reserver: { id: 12, username: "liam_k" },
        startTime: "2026-10-21T10:00:00",
        endTime: "2026-10-21T11:00:00",
      }],
    });

    const resourceQuery = database.queries.find((query) => query.text.includes("rv.user_id = $1"));
    expect(resourceQuery?.text).toContain("rv.status IN ('confirmed', 'completed')");
    expect(resourceQuery?.text).toContain("review.review_id IS NULL");
    const userQuery = database.queries.find((query) => query.text.includes("resource.owner_id = $1"));
    expect(userQuery?.text).toContain("rv.status = 'completed'");
    expect(userQuery?.text).toContain("interval '7 days'");
    expect(userQuery?.text).toContain("rv.user_id <> resource.owner_id");
    expectReadOnly(database.queries);
  });

  it("reports database failures as 503", async () => {
    const { database, app } = setup();
    database.failWith = new Error("timeout");

    const response = await app.request(
      "http://localhost/api/reviews/mine",
      { headers: authHeaders },
      database.environment(),
    );

    expect(response.status).toBe(503);
  });
});
