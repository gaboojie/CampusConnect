import { describe, expect, it } from "vitest";
import { parseListingInput } from "../db/repositories/listings";
import { createApp } from "../backend/index";
import { FakeReadDatabase, authHeaders } from "./support/fakeReadDatabase";

const validBody = {
  name: "Quiet study room",
  description: "A small room for focused work.",
  locationDescription: "Fourth floor beside the group study area.",
  buildingId: "1",
  categoryId: "1",
  requiredCredits: "2",
  capacity: "4",
  maxReservationHours: "2",
  maxReservationMinutes: "30",
  availability: JSON.stringify([{
    startTime: "2026-10-20T09:00",
    endTime: "2026-10-20T17:00",
    repeat: "weekly",
    repeatsUntil: "2026-12-18T17:00",
  }]),
  removeImage: "false",
};

describe("listing input validation", () => {
  it("parses the owner form without accepting an owner id", () => {
    const result = parseListingInput(validBody);

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        name: "Quiet study room",
        buildingId: 1,
        categoryId: 1,
        requiredCredits: 2,
        minUserReviewScore: null,
        capacity: 4,
        maxReservationMinutes: 150,
        availability: [{
          startTime: "2026-10-20 09:00",
          endTime: "2026-10-20 17:00",
          repeat: "weekly",
          repeatsUntil: "2026-12-18 17:00",
        }],
        image: null,
      }),
    });
  });

  it("rounds an optional minimum user review score to two decimals", () => {
    const result = parseListingInput({ ...validBody, minUserReviewScore: "4.126" });

    expect(result.ok && result.value.minUserReviewScore).toBe(4.13);
  });

  it("parses sorted maintenance periods with their reasons", () => {
    const result = parseListingInput({
      ...validBody,
      maintenancePeriods: JSON.stringify([
        { startTime: "2026-11-02T10:00", endTime: "2026-11-02T12:00", reason: "Equipment repair" },
        { startTime: "2026-11-01T10:00", endTime: "2026-11-01T11:00", reason: "Routine cleaning" },
      ]),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({
        maintenancePeriods: [
          { startTime: "2026-11-01 10:00", endTime: "2026-11-01 11:00", reason: "Routine cleaning" },
          { startTime: "2026-11-02 10:00", endTime: "2026-11-02 12:00", reason: "Equipment repair" },
        ],
      }),
    }));
  });

  it("parses multiple resource features", () => {
    const result = parseListingInput({
      ...validBody,
      features: JSON.stringify([
        { name: "Hoop adjustment mechanism", description: "Manual crank system for adjusting hoop height." },
        { name: "Boundary markings", description: "Dual-color integrated court lines." },
      ]),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({
        features: [
          { name: "Hoop adjustment mechanism", description: "Manual crank system for adjusting hoop height." },
          { name: "Boundary markings", description: "Dual-color integrated court lines." },
        ],
      }),
    }));
  });

  it.each([
    ["short name", { ...validBody, name: "No" }, /Name/],
    ["bad credits", { ...validBody, requiredCredits: "21" }, /Credits/],
    ["minimum score below range", { ...validBody, minUserReviewScore: "0" }, /Minimum user review score/],
    ["minimum score above range", { ...validBody, minUserReviewScore: "5.01" }, /Minimum user review score/],
    ["bad capacity", { ...validBody, capacity: "101" }, /Capacity/],
    ["empty availability", { ...validBody, availability: "[]" }, /at least one availability/],
    ["missing repeat end", { ...validBody, availability: JSON.stringify([{
      startTime: "2026-10-20T09:00",
      endTime: "2026-10-20T17:00",
      repeat: "weekly",
      repeatsUntil: null,
    }]) }, /repeats-until/],
    ["reversed availability", { ...validBody, availability: JSON.stringify([{
      startTime: "2026-10-20T17:00",
      endTime: "2026-10-20T09:00",
      repeat: "none",
      repeatsUntil: null,
    }]) }, /after/],
    ["longer than repeat interval", { ...validBody, availability: JSON.stringify([{
      startTime: "2026-10-20T09:00",
      endTime: "2026-10-21T10:00",
      repeat: "daily",
      repeatsUntil: "2026-10-25T10:00",
    }]) }, /cannot exceed/],
    ["maintenance without a reason", {
      ...validBody,
      maintenancePeriods: JSON.stringify([
        { startTime: "2026-11-01T10:00", endTime: "2026-11-01T11:00", reason: "" },
      ]),
    }, /reason/],
    ["overlapping maintenance periods", {
      ...validBody,
      maintenancePeriods: JSON.stringify([
        { startTime: "2026-11-01T10:00", endTime: "2026-11-01T12:00", reason: "Repair equipment" },
        { startTime: "2026-11-01T11:00", endTime: "2026-11-01T13:00", reason: "Inspect equipment" },
      ]),
    }, /cannot overlap/],
    ["feature missing description", {
      ...validBody,
      features: JSON.stringify([{ name: "Scoreboard", description: "" }]),
    }, /Feature descriptions/],
    ["zero duration", { ...validBody, maxReservationHours: "0", maxReservationMinutes: "0" }, /at least one minute/],
    ["bad minute value", { ...validBody, maxReservationHours: "0", maxReservationMinutes: "60" }, /at least one minute/],
  ])("rejects %s", (_label, body, message) => {
    const result = parseListingInput(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });

  it("rejects images over one megabyte and unsupported types", () => {
    const tooLarge = new File([new Uint8Array(1024 * 1024 + 1)], "large.jpg", { type: "image/jpeg" });
    const result = parseListingInput({ ...validBody, image: tooLarge });
    expect(result).toEqual({ ok: false, error: "Images must be 1 MB or smaller." });

    const unsupported = new File(["gif"], "image.gif", { type: "image/gif" });
    const unsupportedResult = parseListingInput({ ...validBody, image: unsupported });
    expect(unsupportedResult).toEqual({ ok: false, error: "Images must be JPEG, PNG, or WebP files." });
  });
});

describe("listing endpoints", () => {
  it.each([
    ["GET", "/api/listings"],
    ["GET", "/api/listings/1"],
    ["POST", "/api/listings"],
    ["PATCH", "/api/listings/1"],
    ["DELETE", "/api/listings/1"],
    ["GET", "/api/resource-images/1"],
  ])("requires a session for %s %s", async (method, path) => {
    const database = new FakeReadDatabase();
    const app = createApp({ createDatabaseClient: () => database.createClient() });
    const response = await app.request(
      `http://localhost${path}`,
      { method, headers: method === "POST" || method === "PATCH" ? { "content-type": "multipart/form-data" } : {} },
      database.environment(),
    );
    expect(response.status).toBe(401);
  });

  it("lists only the current owner's resources", async () => {
    const database = new FakeReadDatabase().respond("SELECT r.resource_id", [
      {
        resource_id: 12,
        name: "Quiet study room",
        description: "A small room for focused work.",
        capacity: 4,
        category_id: 1,
        category_name: "Study Room",
        building_id: 1,
        building_name: "Newman Library",
        image_id: null,
        average_rating: null,
        review_count: 0,
        active_start: null,
        active_end: null,
      },
    ]);
    const app = createApp({ createDatabaseClient: () => database.createClient() });
    const response = await app.request("http://localhost/api/listings", { headers: authHeaders }, database.environment());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      listings: [{
        id: 12,
        name: "Quiet study room",
        category: { id: 1, name: "Study Room" },
        building: { id: 1, name: "Newman Library" },
        capacity: 4,
        shortDescription: "A small room for focused work.",
        averageRating: null,
        reviewCount: 0,
        thumbnailUrl: null,
        hasActiveReservation: false,
        activeReservation: null,
      }],
    });
  });
});
