import { describe, expect, it, vi } from "vitest";
import { createApp } from "../backend/index";
import { findBuildingByGooglePlaceId, findMapBuildingById } from "../db/repositories/maps";
import { FakeReadDatabase, SESSION_TOKEN, authHeaders, expectReadOnly } from "./support/fakeReadDatabase";

const buildingRow = {
  building_id: 5,
  building_name: "Squires Student Center",
  address: "290 College Ave., Blacksburg, VA 24061",
  latitude: "37.229620",
  longitude: "-80.417960",
  google_place_id: "ChIJbuilding5",
};

function setup(config: {
  key?: string;
  mapId?: string;
  placesKey?: string;
  placesFetch?: typeof fetch;
} = {}) {
  const database = new FakeReadDatabase();
  const app = createApp({
    createDatabaseClient: () => database.createClient(),
    fetchGooglePlaces: config.placesFetch,
  });
  const environment = {
    ...database.environment(),
    ...(config.key === undefined ? {} : { GOOGLE_MAPS_JAVASCRIPT_API_KEY: config.key }),
    ...(config.mapId === undefined ? {} : { GOOGLE_MAPS_MAP_ID: config.mapId }),
    ...(config.placesKey === undefined ? {} : { GOOGLE_PLACES_API_KEY: config.placesKey }),
  };

  return {
    database,
    getConfig: (headers: Record<string, string> = authHeaders) =>
      app.request("http://localhost/api/maps/config", { headers }, environment),
    getBuildings: (headers: Record<string, string> = authHeaders) =>
      app.request("http://localhost/api/maps/buildings", { headers }, environment),
    getBuildingDetails: (id: string, headers: Record<string, string> = authHeaders) =>
      app.request(`http://localhost/api/maps/buildings/${id}/details`, { headers }, environment),
  };
}

describe("GET /api/maps/config", () => {
  it("requires an authenticated session", async () => {
    const { getConfig, database } = setup({ key: "test-key" });

    const response = await getConfig({});

    expect(response.status).toBe(401);
    expect(database.queries).toEqual([]);
  });

  it("returns the configured JavaScript API key and map ID", async () => {
    const { getConfig } = setup({ key: "test-key", mapId: "campusconnect-map" });

    const response = await getConfig();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      googleMapsJavaScriptApiKey: "test-key",
      mapId: "campusconnect-map",
    });
  });

  it("returns null when the map configuration is not configured", async () => {
    const { getConfig } = setup();

    const response = await getConfig();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      googleMapsJavaScriptApiKey: null,
      mapId: null,
    });
  });

  it("preserves the existing banned-account restriction", async () => {
    const { getConfig, database } = setup({ key: "test-key" });
    database.sessionBanned = true;

    const response = await getConfig({ cookie: `campusconnect_session=${SESSION_TOKEN}` });

    expect(response.status).toBe(403);
  });
});

describe("GET /api/maps/buildings", () => {
  it("requires an authenticated session", async () => {
    const { getBuildings, database } = setup();

    const response = await getBuildings({});

    expect(response.status).toBe(401);
    expect(database.queries).toEqual([]);
  });

  it("returns coordinates and nullable Google Place IDs", async () => {
    const { getBuildings, database } = setup();
    database.respond("SELECT building_id", [buildingRow, { ...buildingRow, google_place_id: null }]);

    const response = await getBuildings();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      buildings: [
        {
          id: 5,
          name: "Squires Student Center",
          address: "290 College Ave., Blacksburg, VA 24061",
          latitude: 37.22962,
          longitude: -80.41796,
          googlePlaceId: "ChIJbuilding5",
        },
        {
          id: 5,
          name: "Squires Student Center",
          address: "290 College Ave., Blacksburg, VA 24061",
          latitude: 37.22962,
          longitude: -80.41796,
          googlePlaceId: null,
        },
      ],
    });
    expectReadOnly(database.queries);
  });
});

describe("GET /api/maps/buildings/:id/details", () => {
  it("requires an authenticated session", async () => {
    const { getBuildingDetails, database } = setup({ placesKey: "places-secret" });

    const response = await getBuildingDetails("5", {});

    expect(response.status).toBe(401);
    expect(database.queries).toEqual([]);
  });

  it("preserves the existing banned-account restriction", async () => {
    const { getBuildingDetails, database } = setup({ placesKey: "places-secret" });
    database.sessionBanned = true;

    const response = await getBuildingDetails("5");

    expect(response.status).toBe(403);
  });

  it("returns 404 for an unknown building", async () => {
    const placesFetch = vi.fn<typeof fetch>();
    const { getBuildingDetails, database } = setup({
      placesKey: "places-secret",
      placesFetch,
    });
    database.respond("SELECT building_id", []);

    const response = await getBuildingDetails("999");

    expect(response.status).toBe(404);
    expect(placesFetch).not.toHaveBeenCalled();
  });

  it("does not call Google when the building has no Place ID", async () => {
    const placesFetch = vi.fn<typeof fetch>();
    const { getBuildingDetails, database } = setup({
      placesKey: "places-secret",
      placesFetch,
    });
    database.respond("SELECT building_id", [{ ...buildingRow, google_place_id: null }]);

    const response = await getBuildingDetails("5");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      building: {
        id: 5,
        name: "Squires Student Center",
        address: "290 College Ave., Blacksburg, VA 24061",
        latitude: 37.22962,
        longitude: -80.41796,
        googlePlaceId: null,
      },
      photos: [],
      photoError: null,
    });
    expect(placesFetch).not.toHaveBeenCalled();
  });

  it("returns local building data when Places is not configured", async () => {
    const placesFetch = vi.fn<typeof fetch>();
    const { getBuildingDetails, database } = setup({ placesFetch });
    database.respond("SELECT building_id", [buildingRow]);

    const response = await getBuildingDetails("5");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      building: {
        id: 5,
        googlePlaceId: "ChIJbuilding5",
      },
      photos: [],
      photoError: "Google building photos are not configured for this environment.",
    });
    expect(placesFetch).not.toHaveBeenCalled();
  });

  it("fetches the first three photos with a narrow field mask and returns attributions", async () => {
    const placesFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/places/ChIJbuilding5")) {
        return new Response(JSON.stringify({
          photos: [
            {
              name: "places/ChIJbuilding5/photos/photo-1",
              authorAttributions: [{ displayName: "Campus Photographer", uri: "//maps.google.com/contrib/1" }],
            },
            { name: "places/ChIJbuilding5/photos/photo-2", authorAttributions: [] },
            { name: "places/ChIJbuilding5/photos/photo-3", authorAttributions: [] },
            { name: "places/ChIJbuilding5/photos/photo-4", authorAttributions: [] },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ photoUri: `https://images.example/${url.split("/").at(-2)}.jpg` }), { status: 200 });
    });
    const { getBuildingDetails, database } = setup({
      placesKey: "places-secret",
      placesFetch,
    });
    database.respond("SELECT building_id", [buildingRow]);

    const response = await getBuildingDetails("5");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      building: {
        id: 5,
        name: "Squires Student Center",
        address: "290 College Ave., Blacksburg, VA 24061",
        latitude: 37.22962,
        longitude: -80.41796,
        googlePlaceId: "ChIJbuilding5",
      },
      photos: [
        {
          url: "https://images.example/photo-1.jpg",
          authorAttributions: [{ displayName: "Campus Photographer", uri: "https://maps.google.com/contrib/1" }],
        },
        { url: "https://images.example/photo-2.jpg", authorAttributions: [] },
        { url: "https://images.example/photo-3.jpg", authorAttributions: [] },
      ],
      photoError: null,
    });
    expect(placesFetch).toHaveBeenCalledTimes(4);
    const detailHeaders = new Headers(placesFetch.mock.calls[0]?.[1]?.headers);
    expect(detailHeaders.get("X-Goog-Api-Key")).toBe("places-secret");
    expect(detailHeaders.get("X-Goog-FieldMask")).toBe("photos");
  });

  it("degrades to the local placeholder when Google fails without exposing the key", async () => {
    const placesFetch = vi.fn<typeof fetch>(async () => new Response("failure", { status: 500 }));
    const { getBuildingDetails, database } = setup({
      placesKey: "places-secret",
      placesFetch,
    });
    database.respond("SELECT building_id", [buildingRow]);

    const response = await getBuildingDetails("5");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("places-secret");
    expect(JSON.parse(body)).toMatchObject({
      photos: [],
      photoError: "Building photos are unavailable right now.",
    });
  });
});

describe("findBuildingByGooglePlaceId", () => {
  it("looks up one building by its exact stored Place ID", async () => {
    const database = new FakeReadDatabase();
    database.respond("SELECT building_id", [buildingRow]);

    const building = await findBuildingByGooglePlaceId(database.createClient(), "ChIJbuilding5");

    expect(building).toEqual({
      id: 5,
      name: "Squires Student Center",
      address: "290 College Ave., Blacksburg, VA 24061",
      latitude: 37.22962,
      longitude: -80.41796,
      googlePlaceId: "ChIJbuilding5",
    });
    expect(database.queries.at(-1)?.values).toEqual(["ChIJbuilding5"]);
    expectReadOnly(database.queries);
  });

  it("looks up one building by its exact database ID", async () => {
    const database = new FakeReadDatabase();
    database.respond("SELECT building_id", [buildingRow]);

    const building = await findMapBuildingById(database.createClient(), 5);

    expect(building?.id).toBe(5);
    expect(database.queries.at(-1)?.values).toEqual([5]);
    expectReadOnly(database.queries);
  });
});
