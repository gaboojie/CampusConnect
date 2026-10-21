import type { DatabaseClient } from "../client";
import type { DatabaseUserRow } from "../../backend/auth";

export async function healthCheck(client: DatabaseClient): Promise<void> {
  await client.query("SELECT 1");
}

export async function findAuthenticatedUser(
  client: DatabaseClient,
  tokenHash: string,
): Promise<DatabaseUserRow | null> {
  const result = await client.query<DatabaseUserRow>(
    `
      SELECT
        u.user_id,
        u.username,
        u.email,
        u.phone_number,
        u.role,
        u.created_at,
        u.credit_balance,
        u.credit_last_reset,
        u.email_notifications_on,
        u.text_notifications_on,
        u.can_add_resources,
        u.is_banned
      FROM "Session" AS s
      JOIN "User" AS u ON u.user_id = s.user_id
      WHERE s.token_hash = $1::bytea
        AND s.expires_at > CURRENT_TIMESTAMP
        AND u.is_banned = FALSE
      LIMIT 1
    `,
    [tokenHash],
  );

  return result.rows[0] ?? null;
}

export type SignupRecordInput = {
  username: string;
  email: string;
  passwordHash: string;
  phoneNumber: string | null;
  emailNotificationsOn: boolean;
  textNotificationsOn: boolean;
  verificationTokenHash: string;
};

export async function createSignupRecord(
  client: DatabaseClient,
  input: SignupRecordInput,
): Promise<DatabaseUserRow> {
  await client.query("BEGIN");

  try {
    const userResult = await client.query<DatabaseUserRow>(
      `
        INSERT INTO "User" (
          username,
          email,
          password_hash,
          phone_number,
          role,
          credit_balance,
          credit_last_reset,
          is_banned,
          can_add_resources,
          email_notifications_on,
          text_notifications_on,
          email_verified_at
        )
        VALUES ($1, $2, $3, $4, 'student', 20, CURRENT_DATE, FALSE, TRUE, $5, $6, NULL)
        RETURNING
          user_id,
          username,
          email,
          phone_number,
          role,
          created_at,
          credit_balance,
          credit_last_reset,
          email_notifications_on,
          text_notifications_on,
          can_add_resources,
          email_verified_at
      `,
      [
        input.username,
        input.email,
        input.passwordHash,
        input.phoneNumber,
        input.emailNotificationsOn,
        input.textNotificationsOn,
      ],
    );
    const user = userResult.rows[0];

    if (!user) {
      throw new Error("Account creation did not return a user");
    }

    await client.query(
      `
        INSERT INTO "CreditTransaction" (user_id, amount, transaction_type)
        VALUES ($1, 20, 'initial_grant')
      `,
      [user.user_id],
    );

    await client.query(
      `
        INSERT INTO "EmailVerificationToken" (user_id, token_hash)
        VALUES ($1, $2::bytea)
      `,
      [user.user_id, input.verificationTokenHash],
    );

    await client.query("COMMIT");
    return user;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function verifyEmailToken(
  client: DatabaseClient,
  tokenHash: string,
): Promise<boolean> {
  await client.query("BEGIN");

  try {
    const tokenResult = await client.query<{ token_id: number; user_id: number }>(
      `
        SELECT token_id, user_id
        FROM "EmailVerificationToken"
        WHERE token_hash = $1::bytea
          AND used_at IS NULL
        FOR UPDATE
      `,
      [tokenHash],
    );
    const token = tokenResult.rows[0];

    if (!token) {
      await client.query("COMMIT");
      return false;
    }

    await client.query(
      `
        UPDATE "EmailVerificationToken"
        SET used_at = CURRENT_TIMESTAMP
        WHERE token_id = $1 AND used_at IS NULL
      `,
      [token.token_id],
    );
    await client.query(
      `
        UPDATE "User"
        SET email_verified_at = CURRENT_TIMESTAMP
        WHERE user_id = $1
      `,
      [token.user_id],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function createVerificationTokenRecord(
  client: DatabaseClient,
  email: string,
  tokenHash: string,
): Promise<{ email: string; userId: number } | null> {
  await client.query("BEGIN");

  try {
    const userResult = await client.query<DatabaseUserRow>(
      `
        SELECT user_id, email, email_verified_at, is_banned
        FROM "User"
        WHERE LOWER(email) = LOWER($1)
        LIMIT 1
      `,
      [email],
    );
    const user = userResult.rows[0];

    if (!user || user.email_verified_at || user.is_banned) {
      await client.query("COMMIT");
      return null;
    }

    await client.query(
      `
        UPDATE "EmailVerificationToken"
        SET used_at = CURRENT_TIMESTAMP
        WHERE user_id = $1 AND used_at IS NULL
      `,
      [user.user_id],
    );
    await client.query(
      `
        INSERT INTO "EmailVerificationToken" (user_id, token_hash)
        VALUES ($1, $2::bytea)
      `,
      [user.user_id, tokenHash],
    );
    await client.query("COMMIT");

    return { email: user.email, userId: user.user_id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function findLoginUser(
  client: DatabaseClient,
  identifier: string,
): Promise<DatabaseUserRow | null> {
  const result = await client.query<DatabaseUserRow>(
    `
      SELECT
        user_id,
        username,
        email,
        phone_number,
        role,
        created_at,
        credit_balance,
        credit_last_reset,
        email_notifications_on,
        text_notifications_on,
        can_add_resources,
        email_verified_at,
        password_hash,
        is_banned
      FROM "User"
      WHERE LOWER(email) = LOWER($1) OR username = $1
      LIMIT 1
    `,
    [identifier],
  );

  return result.rows[0] ?? null;
}

export async function createSessionRecord(
  client: DatabaseClient,
  userId: number,
  tokenHash: string,
  expiresAt: Date,
): Promise<void> {
  await client.query("BEGIN");

  try {
    await client.query(
      `
        INSERT INTO "Session" (user_id, token_hash, expires_at)
        VALUES ($1, $2::bytea, $3)
      `,
      [userId, tokenHash, expiresAt],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function deleteSession(
  client: DatabaseClient,
  tokenHash: string,
): Promise<void> {
  await client.query(
    `DELETE FROM "Session" WHERE token_hash = $1::bytea`,
    [tokenHash],
  );
}

export async function getPasswordHash(
  client: DatabaseClient,
  userId: number,
): Promise<string | null | undefined> {
  const result = await client.query<{ password_hash: string | null }>(
    `SELECT password_hash FROM "User" WHERE user_id = $1`,
    [userId],
  );

  return result.rows[0]?.password_hash;
}

export async function updatePassword(
  client: DatabaseClient,
  userId: number,
  passwordHash: string,
  currentTokenHash: string,
): Promise<void> {
  await client.query("BEGIN");

  try {
    await client.query(
      `UPDATE "User" SET password_hash = $1 WHERE user_id = $2`,
      [passwordHash, userId],
    );
    await client.query(
      `DELETE FROM "Session" WHERE user_id = $1 AND token_hash <> $2::bytea`,
      [userId, currentTokenHash],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
