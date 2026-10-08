CREATE TABLE IF NOT EXISTS prod_environment_smoke (
  id integer PRIMARY KEY CHECK (id = 1),
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO prod_environment_smoke (id, message)
VALUES (1, 'CampusConnect production database is connected')
ON CONFLICT (id) DO UPDATE
SET message = EXCLUDED.message;
