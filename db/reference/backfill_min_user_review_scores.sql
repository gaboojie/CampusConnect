-- Backfill the resource minimum user-review score policy.
-- Safe to run more than once: all existing values are normalized before the
-- selected resource IDs are assigned their thresholds.

BEGIN;

ALTER TABLE "Resource"
    ADD COLUMN IF NOT EXISTS min_user_review_score numeric(3,2);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = '"Resource"'::regclass
          AND conname = 'ck_resource_min_user_review_score'
    ) THEN
        ALTER TABLE "Resource"
            ADD CONSTRAINT ck_resource_min_user_review_score CHECK (
                min_user_review_score IS NULL
                OR min_user_review_score BETWEEN 1.00 AND 5.00
            );
    END IF;
END
$$;

-- All resources are unrestricted unless explicitly selected below.
UPDATE "Resource"
SET min_user_review_score = NULL;

UPDATE "Resource"
SET min_user_review_score = CASE resource_id
    WHEN 10 THEN 4.00
    WHEN 14 THEN 4.50
    WHEN 20 THEN 4.00
    WHEN 21 THEN 3.50
    ELSE NULL
END;

COMMIT;
