-- -----------------------------------------------------------------------------
-- Review schema update
--
-- This migration makes the relationship between a resource review and the
-- completed reservation that authorized it explicit, and renames the review
-- table for reviews of users.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
    IF to_regclass('public."ReservationReview"') IS NOT NULL
       AND to_regclass('public."UserReview"') IS NULL THEN
        ALTER TABLE "ReservationReview" RENAME TO "UserReview";
    END IF;
END
$$;

DO $$
BEGIN
    IF to_regclass('public."UserReview"') IS NOT NULL THEN
        IF EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = 'public."UserReview"'::regclass
              AND conname = 'pk_reservationreview'
        ) THEN
            ALTER TABLE "UserReview" RENAME CONSTRAINT pk_reservationreview TO pk_userreview;
        END IF;
        IF EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = 'public."UserReview"'::regclass
              AND conname = 'ck_reservationreview_reviewer_not_reviewee'
        ) THEN
            ALTER TABLE "UserReview"
                RENAME CONSTRAINT ck_reservationreview_reviewer_not_reviewee
                TO ck_userreview_reviewer_not_reviewee;
        END IF;
        IF EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = 'public."UserReview"'::regclass
              AND conname = 'fk_reservationreview_reservation'
        ) THEN
            ALTER TABLE "UserReview"
                RENAME CONSTRAINT fk_reservationreview_reservation
                TO fk_userreview_reservation;
        END IF;
        IF EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = 'public."UserReview"'::regclass
              AND conname = 'fk_reservationreview_reviewer'
        ) THEN
            ALTER TABLE "UserReview"
                RENAME CONSTRAINT fk_reservationreview_reviewer
                TO fk_userreview_reviewer;
        END IF;
        IF EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = 'public."UserReview"'::regclass
              AND conname = 'fk_reservationreview_reviewee'
        ) THEN
            ALTER TABLE "UserReview"
                RENAME CONSTRAINT fk_reservationreview_reviewee
                TO fk_userreview_reviewee;
        END IF;
    END IF;
END
$$;

ALTER TABLE "ResourceReview"
    ADD COLUMN IF NOT EXISTS reservation_id integer;

-- Existing rows are matched to the closest completed reservation by the same
-- user for the same resource that ended before the review was created. This
-- handles repeated reservations of one resource by one user as well.
WITH candidates AS (
    SELECT
        rr.review_id,
        r.reservation_id,
        ROW_NUMBER() OVER (
            PARTITION BY rr.review_id
            ORDER BY r.end_time DESC, r.reservation_id DESC
        ) AS review_rank
    FROM "ResourceReview" AS rr
    JOIN "Reservation" AS r
      ON r.resource_id = rr.resource_id
     AND r.user_id = rr.reviewer_user_id
     AND r.status = 'completed'
     AND r.end_time <= rr.created_at
    WHERE rr.reservation_id IS NULL
)
UPDATE "ResourceReview" AS rr
SET reservation_id = candidates.reservation_id
FROM candidates
WHERE candidates.review_id = rr.review_id
  AND candidates.review_rank = 1;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "ResourceReview" WHERE reservation_id IS NULL) THEN
        RAISE EXCEPTION
            'Cannot backfill ResourceReview.reservation_id: one or more reviews have no matching completed reservation';
    END IF;
END
$$;

ALTER TABLE "ResourceReview"
    ALTER COLUMN reservation_id SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public."ResourceReview"'::regclass
          AND conname = 'uq_resourcereview_reservation'
    ) THEN
        ALTER TABLE "ResourceReview"
            ADD CONSTRAINT uq_resourcereview_reservation UNIQUE (reservation_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public."ResourceReview"'::regclass
          AND conname = 'fk_resourcereview_reservation'
    ) THEN
        ALTER TABLE "ResourceReview"
            ADD CONSTRAINT fk_resourcereview_reservation
            FOREIGN KEY (reservation_id) REFERENCES "Reservation" (reservation_id)
            ON UPDATE CASCADE ON DELETE CASCADE;
    END IF;
END
$$;
