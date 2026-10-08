CREATE TABLE IF NOT EXISTS dev_environment_smoke (
  id integer PRIMARY KEY CHECK (id = 1),
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO dev_environment_smoke (id, message)
VALUES (1, 'CampusConnect dev database is connected')
ON CONFLICT (id) DO UPDATE
SET message = EXCLUDED.message;
