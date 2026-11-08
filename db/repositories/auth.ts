import type { DatabaseClient } from "../client";
import type { DatabaseUserRow } from "../../backend/auth";

const AUTH_USER_COLUMNS = `
  u.user_id,
  u.username,
  u.email,
  u.role,
  u.created_at,
  u.credit_balance,
  u.credit_last_reset,
  u.email_notifications_on,
  u.can_add_resources,
  u.is_banned,
  u.is_account_deleted,
  u.profile_image_id
`;

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
        ${AUTH_USER_COLUMNS}
      FROM "Session" AS s
      JOIN "User" AS u ON u.user_id = s.user_id
      WHERE s.token_hash = $1::bytea
        AND s.expires_at > CURRENT_TIMESTAMP
        AND u.is_account_deleted = FALSE
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
  emailNotificationsOn: boolean;
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
          role,
          credit_balance,
          credit_last_reset,
          is_banned,
          can_add_resources,
          email_notifications_on,
          email_verified_at
        )
        VALUES ($1, $2, $3, 'student', 20, CURRENT_DATE, FALSE, TRUE, $4, NULL)
        RETURNING
          user_id,
          username,
          email,
          role,
          created_at,
          credit_balance,
          credit_last_reset,
          email_notifications_on,
          can_add_resources,
          email_verified_at,
          is_banned,
          is_account_deleted,
          profile_image_id
      `,
      [
        input.username,
        input.email,
        input.passwordHash,
        input.emailNotificationsOn,
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
        SELECT user_id, email, email_verified_at, is_banned, is_account_deleted
        FROM "User"
        WHERE LOWER(email) = LOWER($1)
        LIMIT 1
      `,
      [email],
    );
    const user = userResult.rows[0];

    if (!user || user.email_verified_at || user.is_banned || user.is_account_deleted) {
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
        ${AUTH_USER_COLUMNS.replaceAll("u.", "")},
        email_verified_at,
        password_hash
      FROM "User"
      WHERE LOWER(email) = LOWER($1) OR username = $1
      LIMIT 1
    `,
    [identifier],
  );

  return result.rows[0] ?? null;
}

export async function updateUsername(
  client: DatabaseClient,
  userId: number,
  username: string,
): Promise<void> {
  await client.query(
    `UPDATE "User" SET username = $1 WHERE user_id = $2 AND is_account_deleted = FALSE`,
    [username, userId],
  );
}

export async function updateNotificationSettings(
  client: DatabaseClient,
  userId: number,
  emailNotificationsOn: boolean,
): Promise<void> {
  await client.query(
    `
      UPDATE "User"
      SET email_notifications_on = $1
      WHERE user_id = $2 AND is_account_deleted = FALSE
    `,
    [emailNotificationsOn, userId],
  );
}

export type ProfileImageUpdateResult =
  | { ok: true; oldObjectKey: string | null }
  | { ok: false; status: 400 | 503; error: string };

function profileImageKey(userId: number, file: File): string {
  const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  return `users/${userId}/profile-${crypto.randomUUID()}.${extension}`;
}

export async function updateProfileImage(
  client: DatabaseClient,
  bucket: R2Bucket | undefined,
  userId: number,
  file: File | null,
  removeImage: boolean,
): Promise<ProfileImageUpdateResult> {
  if (!file && !removeImage) {
    return { ok: false, status: 400, error: "Choose a profile image or remove the current image." };
  }
  if (file && !bucket) {
    return { ok: false, status: 503, error: "Image storage is not configured right now." };
  }

  let uploadedKey: string | null = null;
  let committed = false;
  let oldObjectKey: string | null = null;

  await client.query("BEGIN");
  try {
    const current = await client.query<{ image_id: number | null; object_key: string | null }>(
      `
        SELECT u.profile_image_id AS image_id, img.object_key
        FROM "User" AS u
        LEFT JOIN "ImageMetadata" AS img ON img.image_id = u.profile_image_id
        WHERE u.user_id = $1 AND u.is_account_deleted = FALSE
        FOR UPDATE OF u
      `,
      [userId],
    );
    const currentImage = current.rows[0];
    if (!currentImage) {
      await client.query("ROLLBACK");
      return { ok: false, status: 400, error: "That account is no longer available." };
    }
    oldObjectKey = currentImage.object_key;

    if (file) {
      uploadedKey = profileImageKey(userId, file);
      await bucket!.put(uploadedKey, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type },
        customMetadata: { filename: file.name },
      });
      const inserted = await client.query<{ image_id: number }>(
        `
          INSERT INTO "ImageMetadata" (object_key, content_type, size, width, height, alt_text, status, filename)
          VALUES ($1, $2, $3, 0, 0, 'Profile photo', 'ready', $4)
          RETURNING image_id
        `,
        [uploadedKey, file.type, file.size, file.name],
      );
      await client.query(
        `UPDATE "User" SET profile_image_id = $1 WHERE user_id = $2`,
        [inserted.rows[0].image_id, userId],
      );
      if (currentImage.image_id !== null) {
        await client.query(`DELETE FROM "ImageMetadata" WHERE image_id = $1`, [currentImage.image_id]);
      }
    } else {
      await client.query(`UPDATE "User" SET profile_image_id = NULL WHERE user_id = $1`, [userId]);
      if (currentImage.image_id !== null) {
        await client.query(`DELETE FROM "ImageMetadata" WHERE image_id = $1`, [currentImage.image_id]);
      }
    }

    await client.query("COMMIT");
    committed = true;
    if (oldObjectKey && bucket) {
      try {
        await bucket.delete(oldObjectKey);
      } catch (error) {
        console.error(`Profile image cleanup failed for ${oldObjectKey}:`, error);
      }
    }
    return { ok: true, oldObjectKey };
  } catch {
    if (!committed) await client.query("ROLLBACK");
    if (uploadedKey && bucket) {
      try {
        await bucket.delete(uploadedKey);
      } catch (error) {
        console.error(`Profile image cleanup failed for ${uploadedKey}:`, error);
      }
    }
    throw new Error("Unable to update the profile image right now.");
  }
}

export async function deleteAccount(
  client: DatabaseClient,
  bucket: R2Bucket | undefined,
  userId: number,
  username: string,
): Promise<boolean> {
  let profileObjectKey: string | null = null;
  await client.query("BEGIN");

  try {
    const current = await client.query<{ username: string; profile_image_id: number | null; object_key: string | null }>(
      `
        SELECT u.username, u.profile_image_id, img.object_key
        FROM "User" AS u
        LEFT JOIN "ImageMetadata" AS img ON img.image_id = u.profile_image_id
        WHERE u.user_id = $1 AND u.is_account_deleted = FALSE
        FOR UPDATE OF u
      `,
      [userId],
    );
    const row = current.rows[0];
    if (!row || row.username !== username) {
      await client.query("ROLLBACK");
      return false;
    }
    profileObjectKey = row.object_key;

    await client.query(`DELETE FROM "EmailVerificationToken" WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM "Session" WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM "Notification" WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM "ReservationReview" WHERE reviewer_user_id = $1 OR reviewee_user_id = $1`, [userId]);
    await client.query(`DELETE FROM "ResourceReview" WHERE reviewer_user_id = $1`, [userId]);
    if (row.profile_image_id !== null) {
      await client.query(`DELETE FROM "ImageMetadata" WHERE image_id = $1`, [row.profile_image_id]);
    }
    // Keep the unique login identifiers so a later login can explain that the
    // account was deleted instead of returning a misleading credential error.
    await client.query(
      `
        UPDATE "User"
        SET password_hash = NULL,
            email_verified_at = NULL,
            email_notifications_on = FALSE,
            profile_image_id = NULL,
            is_account_deleted = TRUE
        WHERE user_id = $1
      `,
      [userId],
    );
    await client.query("COMMIT");

    if (profileObjectKey && bucket) {
      try {
        await bucket.delete(profileObjectKey);
      } catch (error) {
        console.error(`Profile image cleanup failed for ${profileObjectKey}:`, error);
      }
    }
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
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
