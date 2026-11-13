import { describe, expect, it } from "vitest";
import { createApp } from "../backend/index";
import { parseAdminBuilding } from "../db/repositories/admin";
import { FakeReadDatabase, authHeaders } from "./support/fakeReadDatabase";

const buildingRow = {
  building_id: 6,
  building_name: "Goodwin Hall",
  address: "635 Prices Fork Rd, Blacksburg, VA 24061",
  latitude: "37.231700",
  longitude: "-80.428200",
  google_place_id: null,
  resource_count: "0",
  total: "1",
};

const input = {
  name: "Goodwin Hall",
  address: "635 Prices Fork Rd, Blacksburg, VA 24061",
  latitude: 37.2317,
  longitude: -80.4282,
  googlePlaceId: "",
};

function setup(role = "admin") {
  const database = new FakeReadDatabase();
  database.sessionRole = role;
  const app = createApp({ createDatabaseClient: () => database.createClient() });
  const send = (method: string, path: string, body?: unknown) =>
    app.request(
      `http://localhost${path}`,
      {
        method,
        headers: { ...authHeaders, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      database.environment(),
    );
  return { database, send };
}

describe("admin building input", () => {
  it("accepts a building and stores a blank place id as null", () => {
    expect(parseAdminBuilding(input)).toEqual({
      ok: true,
      value: { ...input, latitude: 37.2317, longitude: -80.4282, googlePlaceId: null },
    });
  });

  it("reports missing name, address, and coordinates", () => {
    const result = parseAdminBuilding({ latitude: 120, longitude: "west" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.fieldErrors).sort()).toEqual(["address", "latitude", "longitude", "name"]);
    }
  });
});

describe("admin building access", () => {
  it("returns 403 for a student", async () => {
    const { send, database } = setup("student");
    expect((await send("GET", "/api/admin/buildings")).status).toBe(403);
    expect((await send("POST", "/api/admin/buildings", input)).status).toBe(403);
    expect((await send("PATCH", "/api/admin/buildings/6", input)).status).toBe(403);
    expect((await send("DELETE", "/api/admin/buildings/6")).status).toBe(403);
    expect(database.queries).toEqual([]);
  });
});

describe("admin building management", () => {
  it("lists buildings", async () => {
    const { send, database } = setup();
    database.respond((query) => query.includes('FROM "Building" AS b'), [buildingRow]);

    const response = await send("GET", "/api/admin/buildings?search=goodwin");
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      total: 1,
      items: [{ id: 6, name: "Goodwin Hall", latitude: 37.2317, longitude: -80.4282, resourceCount: 0 }],
    });
  });

  it("creates a building", async () => {
    const { send, database } = setup();
    database.respond('INSERT INTO "Building"', [buildingRow]);

    const response = await send("POST", "/api/admin/buildings", input);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ building: { id: 6, name: "Goodwin Hall", googlePlaceId: null } });
    expect(database.queries[0].values).toEqual([
      "Goodwin Hall",
      "635 Prices Fork Rd, Blacksburg, VA 24061",
      37.2317,
      -80.4282,
      null,
    ]);
  });

  it("returns the duplicate name when the database rejects it", async () => {
    const { send, database } = setup();
    database.failWith = Object.assign(new Error("duplicate"), { code: "23505", constraint: "uq_building_building_name" });

    const response = await send("POST", "/api/admin/buildings", input);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "A building with this name already exists.",
      fieldErrors: { name: "A building with this name already exists." },
    });
  });

  it("updates a building", async () => {
    const { send, database } = setup();
    database.respond('UPDATE "Building"', [{ ...buildingRow, building_name: "Goodwin Hall East" }]);

    const response = await send("PATCH", "/api/admin/buildings/6", { ...input, name: "Goodwin Hall East" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ building: { id: 6, name: "Goodwin Hall East" } });
  });

  it("returns 404 when the building to update is missing", async () => {
    const { send, database } = setup();
    database.respond('UPDATE "Building"', []);

    const response = await send("PATCH", "/api/admin/buildings/99", input);
    expect(response.status).toBe(404);
  });

  it("deletes a building that has no resources", async () => {
    const { send, database } = setup();
    database
      .respond('SELECT building_id FROM "Building"', [{ building_id: 6 }])
      .respond('SELECT COUNT(*) AS count FROM "Resource"', [{ count: "0" }])
      .respond('DELETE FROM "Building"', []);

    const response = await send("DELETE", "/api/admin/buildings/6");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
  });

  it("refuses to delete a building that still has resources", async () => {
    const { send, database } = setup();
    database
      .respond('SELECT building_id FROM "Building"', [{ building_id: 1 }])
      .respond('SELECT COUNT(*) AS count FROM "Resource"', [{ count: "4" }]);

    const response = await send("DELETE", "/api/admin/buildings/1");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This building still has 4 resources. Move or delete them before deleting the building.",
    });
    expect(database.queries.some((query) => query.text.startsWith('DELETE FROM "Building"'))).toBe(false);
  });
});
