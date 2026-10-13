-- Add password storage for accounts created through the authentication flow.
-- Seeded accounts intentionally remain without passwords in the prototype.
ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS password_hash text;
