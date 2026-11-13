import type { DatabaseClient } from "../client";
import { CAMPUS_NOW_SQL, localTimestampSql } from "./resources";
import type { Reservation } from "./reservations";

export type UserReviewTask = {
  reservationId: number;
  resource: { id: number; name: string };
  building: { id: number; name: string };
  reserver: { id: number; username: string };
  startTime: string;
  endTime: string;
};

export type ReviewInbox = {
  resourceReviews: Reservation[];
  userReviews: UserReviewTask[];
};

type ResourceReviewRow = {
  reservation_id: number;
  status: string;
  start_time: string;
  end_time: string;
  created_at: string;
  resource_id: number;
  resource_name: string;
  building_id: number;
  building_name: string;
};

type UserReviewTaskRow = {
  reservation_id: number;
  resource_id: number;
  resource_name: string;
  building_id: number;
  building_name: string;
  reserver_id: number;
  reserver_username: string;
  start_time: string;
  end_time: string;
};

function toResourceReviewReservation(row: ResourceReviewRow): Reservation {
  return {
    id: row.reservation_id,
    resource: { id: row.resource_id, name: row.resource_name },
    building: { id: row.building_id, name: row.building_name },
    startTime: row.start_time,
    endTime: row.end_time,
    status: row.status,
    createdAt: row.created_at,
    canModify: false,
    creditsCharged: null,
    refundEligible: false,
    canReviewResource: true,
  };
}

export async function listReviewInbox(client: DatabaseClient, userId: number): Promise<ReviewInbox> {
  const resourceReviews = await client.query<ResourceReviewRow>(
    `
      SELECT
        rv.reservation_id,
        rv.status,
        ${localTimestampSql("rv.start_time")} AS start_time,
        ${localTimestampSql("rv.end_time")} AS end_time,
        ${localTimestampSql("rv.created_at")} AS created_at,
        resource.resource_id,
        resource.name AS resource_name,
        building.building_id,
        building.building_name
      FROM "Reservation" AS rv
      JOIN "Resource" AS resource ON resource.resource_id = rv.resource_id
      JOIN "Building" AS building ON building.building_id = resource.building_id
      LEFT JOIN "ResourceReview" AS review ON review.reservation_id = rv.reservation_id
      WHERE rv.user_id = $1
        AND rv.status IN ('confirmed', 'completed')
        AND rv.end_time <= ${CAMPUS_NOW_SQL}
        AND review.review_id IS NULL
      ORDER BY rv.end_time DESC, rv.reservation_id DESC
    `,
    [userId],
  );

  const userReviews = await client.query<UserReviewTaskRow>(
    `
      SELECT
        rv.reservation_id,
        resource.resource_id,
        resource.name AS resource_name,
        building.building_id,
        building.building_name,
        reserver.user_id AS reserver_id,
        reserver.username AS reserver_username,
        ${localTimestampSql("rv.start_time")} AS start_time,
        ${localTimestampSql("rv.end_time")} AS end_time
      FROM "Reservation" AS rv
      JOIN "Resource" AS resource ON resource.resource_id = rv.resource_id
      JOIN "Building" AS building ON building.building_id = resource.building_id
      JOIN "User" AS reserver ON reserver.user_id = rv.user_id
      LEFT JOIN "UserReview" AS review ON review.reservation_id = rv.reservation_id
      WHERE resource.owner_id = $1
        AND rv.status = 'completed'
        AND rv.end_time > ${CAMPUS_NOW_SQL} - interval '7 days'
        AND rv.end_time <= ${CAMPUS_NOW_SQL}
        AND rv.user_id <> resource.owner_id
        AND review.reservation_id IS NULL
      ORDER BY rv.end_time DESC, rv.reservation_id DESC
    `,
    [userId],
  );

  return {
    resourceReviews: resourceReviews.rows.map(toResourceReviewReservation),
    userReviews: userReviews.rows.map((row) => ({
      reservationId: row.reservation_id,
      resource: { id: row.resource_id, name: row.resource_name },
      building: { id: row.building_id, name: row.building_name },
      reserver: { id: row.reserver_id, username: row.reserver_username },
      startTime: row.start_time,
      endTime: row.end_time,
    })),
  };
}
