import { describe, expect, it } from "vitest";
import { createApp } from "../worker/index";
import {
  buildResourceSearchQueries,
  parseResourceSearch,
  shortenDescription,
  type ResourceSearch,
} from "../worker/resources";
import { FakeReadDatabase, authHeaders, expectReadOnly } from "./support/fakeReadDatabase";

const summaryRow = {
  resource_id: 4,
  name: "Newman Group Study Room 4",
  description: "Mid-size group study room with a whiteboard and wall-mounted display.",
  capacity: 6,
  category_id: 1,
  category_name: "Group Study Room",
  building_id: 1,
  building_name: "Carol M. Newman Library",
  average_rating: 4.5,
  review_count: 2,
};

const detailRow = {
  resource_id: 22,
  name: "Squires Meeting Room B",
  description: "Larger meeting room for organization general body meetings, with a projector.",
  location_description: "Squires Student Center",
  capacity: 20,
  required_credits: 3,
  max_reservation_minutes: 180,
  created_at: "2026-08-14T14:00:00",
  category_id: 2,
  category_name: "Meeting Room",
  category_description: "Bookable rooms.",
  building_id: 5,
  building_name: "Squires Student Center",
  address: "290 College Ave., Blacksburg, VA 24061",
  building_latitude: "37.229620",
  building_longitude: "-80.417960",
  owner_username: "squires_events_mp",
  image_id: 6,
  image_alt_text: null,
  average_rating: null,
  review_count: 0,
};

function setup(database = new FakeReadDatabase()) {
  const app = createApp({ createDatabaseClient: () => database.createClient() });
  const get = (path: string, headers: Record<string, string> = authHeaders) =>
    app.request(`http://localhost${path}`, { headers }, database.environment());
  return { app, database, get };
}

function parsed(query: string): ResourceSearch {
  const result = parseResourceSearch(new URLSearchParams(query));
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe("resource search input validation", () => {
  it("uses defaults when no filters are given", () => {
    expect(parsed("")).toEqual({
      q: null,
      categoryId: null,
      buildingId: null,
      features: [],
      minCapacity: null,
      slot: null,
      sort: "name",
      limit: 12,
      offset: 0,
    });
  });

  it("parses combined filters, dedupes features, and caps the limit at 50", () => {
    const search = parsed(
      "q=%20study%20&category=1&building=2&feature=Projector&feature=Projector&feature=Microphone" +
        "&minCapacity=6&date=2026-10-20&start=09:00&end=10:30&sort=rating&limit=500&offset=24",
    );

    expect(search).toEqual({
      q: "study",
      categoryId: 1,
      buildingId: 2,
      features: ["Projector", "Microphone"],
      minCapacity: 6,
      slot: { start: "2026-10-20 09:00", end: "2026-10-20 10:30" },
      sort: "rating",
      limit: 50,
      offset: 24,
    });
  });

  it.each([
    ["q=" + "x".repeat(101), "Search text"],
    ["category=abc", "Category"],
    ["category=0", "Category"],
    ["building=99999999999", "Building"],
    ["minCapacity=-1", "Minimum capacity"],
    ["minCapacity=2.5", "Minimum capacity"],
    ["date=2026-10-20", "together"],
    ["date=2026-02-30&start=09:00&end=10:00", "valid YYYY-MM-DD"],
    ["date=2026-10-20&start=9am&end=10:00", "HH:MM"],
    ["date=2026-10-20&start=10:00&end=10:00", "after the start"],
    ["sort=price", "Sort"],
    ["limit=0", "Limit"],
    ["limit=ten", "Limit"],
    ["offset=-5", "Offset"],
    ["offset=10001", "Offset"],
    [Array.from({ length: 11 }, (_, index) => `feature=f${index}`).join("&"), "at most 10"],
  ])("rejects %s", (query, message) => {
    const result = parseResourceSearch(new URLSearchParams(query));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });

  it("shortens long descriptions for cards", () => {
    expect(shortenDescription("short")).toBe("short");
    const shortened = shortenDescription("word ".repeat(60));
    expect(shortened.length).toBeLessThanOrEqual(160);
    expect(shortened.endsWith("…")).toBe(true);
  });
});

describe("resource search SQL", () => {
  it("binds every user value as a parameter", () => {
    const injection = "x' OR 1=1; DROP TABLE \"Resource\"; --";
    const { count, page } = buildResourceSearchQueries(
      parsed(
        `q=${encodeURIComponent(injection)}&category=1&building=2&feature=${encodeURIComponent(injection)}` +
          "&minCapacity=4&date=2026-10-20&start=09:00&end=10:00&limit=5&offset=10",
      ),
    );

    for (const query of [count, page]) {
      expect(query.text).not.toContain(injection);
      expect(query.text).not.toContain("2026-10-20");
    }
    expect(page.values).toEqual([
      `%${injection}%`,
      1,
      2,
      4,
      [injection],
      "2026-10-20 09:00",
      "2026-10-20 10:00",
      5,
      10,
    ]);
    expect(count.values).toEqual(page.values.slice(0, -2));
  });

  it("escapes LIKE wildcards in the search text", () => {
    const { page } = buildResourceSearchQueries(parsed("q=100%25_off\\"));
    expect(page.values[0]).toBe("%100\\%\\_off\\\\%");
    expect(page.text).toContain("ESCAPE '\\'");
  });

  it("requires all selected features and checks availability, reservations, and maintenance", () => {
    const { page } = buildResourceSearchQueries(
      parsed("feature=Projector&feature=Microphone&date=2026-10-20&start=09:00&end=10:00"),
    );
    const text = page.text.replace(/\s+/g, " ");

    expect(text).toContain("HAVING COUNT(DISTINCT f.feature_name) = cardinality($1::text[])");
    expect(text).toContain('FROM "ResourceAvailability" AS a');
    expect(text).toContain("rv.status <> 'cancelled'");
    expect(text).toContain("rv.start_time < $3::timestamp AND rv.end_time > $2::timestamp");
    expect(text).toContain("mp.start_time < $3::timestamp AND mp.end_time > $2::timestamp");
  });

  it.each([
    ["name", "ORDER BY r.name ASC"],
    ["rating", "ORDER BY average_rating DESC NULLS LAST"],
    ["capacity", "ORDER BY r.capacity DESC"],
  ])("sorts by %s", (sort, orderBy) => {
    const { page } = buildResourceSearchQueries(parsed(`sort=${sort}`));
    expect(page.text.replace(/\s+/g, " ")).toContain(orderBy);
  });

  it("omits the WHERE clause when there are no filters", () => {
    const { count } = buildResourceSearchQueries(parsed(""));
    expect(count.text).not.toContain("WHERE");
    expect(count.values).toEqual([]);
  });
});

describe("GET /api/resources", () => {
  it("requires a session", async () => {
    const { get, database } = setup();
    const response = await get("/api/resources", {});
    expect(response.status).toBe(401);
    expect(database.queries).toEqual([]);
  });

  it("returns paginated summaries", async () => {
    const database = new FakeReadDatabase()
      .respond("SELECT COUNT(*)", [{ total: 13 }])
      .respond("SELECT r.resource_id, r.name, r.description, r.capacity", [summaryRow]);
    const { get } = setup(database);

    const response = await get("/api/resources?category=1&sort=rating&limit=1&offset=3");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resources: [
        {
          id: 4,
          name: "Newman Group Study Room 4",
          category: { id: 1, name: "Group Study Room" },
          building: { id: 1, name: "Carol M. Newman Library" },
          capacity: 6,
          shortDescription: summaryRow.description,
          averageRating: 4.5,
          reviewCount: 2,
          thumbnailUrl: null,
        },
      ],
      total: 13,
      limit: 1,
      offset: 3,
    });
    expect(database.queries).toHaveLength(2);
    expect(database.queries[1].values).toEqual([1, 1, 3]);
    expectReadOnly(database.queries);
  });

  it("rejects invalid filters before touching the database", async () => {
    const { get, database } = setup();
    const response = await get("/api/resources?date=2026-10-20&start=11:00&end=10:00");

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("End time must be after the start time.");
    expect(database.queries).toEqual([]);
  });

  it("reports database failures as 503", async () => {
    const database = new FakeReadDatabase();
    database.failWith = new Error("connection reset");
    const { get } = setup(database);

    const response = await get("/api/resources");
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe("Unable to load resources right now.");
  });
});

describe("GET /api/resources/filters", () => {
  it("returns categories, buildings, and distinct features", async () => {
    const database = new FakeReadDatabase()
      .respond("SELECT category_id", [{ category_id: 1, category_name: "Group Study Room" }])
      .respond("SELECT building_id", [{ building_id: 5, building_name: "Squires Student Center" }])
      .respond("SELECT DISTINCT feature_name", [{ feature_name: "Microphone" }, { feature_name: "Projector" }]);
    const { get } = setup(database);

    const response = await get("/api/resources/filters");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      categories: [{ id: 1, name: "Group Study Room" }],
      buildings: [{ id: 5, name: "Squires Student Center" }],
      features: ["Microphone", "Projector"],
    });
    expectReadOnly(database.queries);
  });

  it("requires a session", async () => {
    const { get } = setup();
    expect((await get("/api/resources/filters", {})).status).toBe(401);
  });
});

describe("GET /api/resources/:id", () => {
  function detailDatabase() {
    return new FakeReadDatabase()
      .respond("SELECT r.resource_id, r.name, r.description, r.location_description", (values) =>
        values[0] === 22 ? [detailRow] : [],
      )
      .respond("SELECT feature_name, description", [
        { feature_name: "Microphone", description: "Wireless microphone." },
      ])
      .respond("WITH week AS", [
        { day: "2026-10-17", weekday: "Saturday", opens_at: null, closes_at: null },
        { day: "2026-10-19", weekday: "Monday", opens_at: "09:00", closes_at: "21:00" },
      ])
      .respond("SELECT maintenance_id", [
        {
          maintenance_id: 6,
          start_time: "2026-10-20T09:00:00",
          end_time: "2026-10-20T21:00:00",
          reason: "Projector replacement.",
        },
      ])
      .respond("SELECT rr.review_id", [
        { review_id: 8, rating: 4, reason: "Warm inside.", created_at: "2026-09-25T10:00:00", reviewer_username: null },
      ]);
  }

  it("returns full details", async () => {
    const database = detailDatabase();
    const { get } = setup(database);

    const response = await get("/api/resources/22");

    expect(response.status).toBe(200);
    const { resource } = (await response.json()) as { resource: unknown };
    expect(resource).toMatchObject({
      id: 22,
      name: "Squires Meeting Room B",
      building: {
        latitude: 37.22962,
        longitude: -80.41796,
      },
      maxReservationMinutes: 180,
      averageRating: null,
      reviewCount: 0,
      features: [{ name: "Microphone", description: "Wireless microphone." }],
      weeklyHours: [
        { date: "2026-10-17", weekday: "Saturday", windows: [] },
        { date: "2026-10-19", weekday: "Monday", windows: [{ opensAt: "09:00", closesAt: "21:00" }] },
      ],
      upcomingMaintenance: [
        { id: 6, startTime: "2026-10-20T09:00:00", endTime: "2026-10-20T21:00:00", reason: "Projector replacement." },
      ],
      images: [{ id: 6, altText: null, url: "/api/resource-images/6" }],
      recentReviews: [
        { id: 8, rating: 4, reason: "Warm inside.", createdAt: "2026-09-25T10:00:00", reviewerUsername: null },
      ],
    });
    expect(database.queries.every((query) => query.values.length === 1 && query.values[0] === 22)).toBe(true);
    expectReadOnly(database.queries);
  });

  it("hides anonymous reviewers in SQL", async () => {
    const database = detailDatabase();
    const { get } = setup(database);
    await get("/api/resources/22");

    const reviewQuery = database.queries.find((query) => query.text.startsWith("SELECT rr.review_id"));
    expect(reviewQuery?.text).toContain("CASE WHEN rr.is_anonymous_review THEN NULL ELSE u.username END");
  });

  it("returns 404 for an unknown resource", async () => {
    const database = detailDatabase();
    const { get } = setup(database);

    const response = await get("/api/resources/9999");
    expect(response.status).toBe(404);
    expect(database.queries).toHaveLength(1);
  });

  it.each(["abc", "0", "-1", "1.5", "99999999999"])("rejects id %s", async (id) => {
    const { get, database } = setup();
    const response = await get(`/api/resources/${id}`);
    expect(response.status).toBe(400);
    expect(database.queries).toEqual([]);
  });

  it("requires a session", async () => {
    const { get } = setup();
    expect((await get("/api/resources/22", {})).status).toBe(401);
  });
});
