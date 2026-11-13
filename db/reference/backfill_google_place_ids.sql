BEGIN;

UPDATE "Building" AS b
SET google_place_id = values.google_place_id
FROM (
    VALUES
        (1, 'Carol M. Newman Library', 'ChIJf8z4LA2VTYgRiVKpkwVghp8'),
        (2, 'Torgersen Hall', 'ChIJg10pxnKVTYgRMNbqYQOUKeg'),
        (3, 'McComas Hall', 'ChIJi9BjOxCVTYgRX0v2h_vGkw0'),
        (4, 'War Memorial Hall', 'EiwzNzAgRHJpbGxmaWVsZCBEciwgQmxhY2tzYnVyZywgVkEgMjQwNjEsIFVTQSIxEi8KFAoSCdlH04ESlU2IEe67gQo6mbjbEPICKhQKEgmxhF-REpVNiBHe3jDxSBoQeg'),
        (5, 'Squires Student Center', 'ChIJTcvBOnOVTYgRUgn8IWXH2fg')
) AS values(building_id, building_name, google_place_id)
WHERE b.building_id = values.building_id
  AND b.building_name = values.building_name;

SELECT building_id, building_name, google_place_id
FROM "Building"
WHERE building_id IN (1, 2, 3, 4, 5)
ORDER BY building_id;

COMMIT;
