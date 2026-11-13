import type { DatabaseClient } from "../client";

export type MapBuilding = {
  id: number;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  googlePlaceId: string | null;
};

type MapBuildingRow = {
  building_id: number;
  building_name: string;
  address: string;
  latitude: number | string;
  longitude: number | string;
  google_place_id: string | null;
};

function mapBuilding(row: MapBuildingRow): MapBuilding {
  return {
    id: row.building_id,
    name: row.building_name,
    address: row.address,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    googlePlaceId: row.google_place_id,
  };
}

const BUILDING_COLUMNS = `
  building_id,
  building_name,
  address,
  latitude,
  longitude,
  google_place_id
`;

export async function listMapBuildings(client: DatabaseClient): Promise<MapBuilding[]> {
  const result = await client.query<MapBuildingRow>(`
    SELECT ${BUILDING_COLUMNS}
    FROM "Building"
    ORDER BY building_name, building_id
  `);

  return result.rows.map(mapBuilding);
}

export async function findMapBuildingById(
  client: DatabaseClient,
  buildingId: number,
): Promise<MapBuilding | null> {
  const result = await client.query<MapBuildingRow>(`
    SELECT ${BUILDING_COLUMNS}
    FROM "Building"
    WHERE building_id = $1
    LIMIT 1
  `, [buildingId]);

  return result.rows[0] ? mapBuilding(result.rows[0]) : null;
}

export async function findBuildingByGooglePlaceId(
  client: DatabaseClient,
  googlePlaceId: string,
): Promise<MapBuilding | null> {
  const result = await client.query<MapBuildingRow>(`
    SELECT ${BUILDING_COLUMNS}
    FROM "Building"
    WHERE google_place_id = $1
    LIMIT 1
  `, [googlePlaceId]);

  return result.rows[0] ? mapBuilding(result.rows[0]) : null;
}
