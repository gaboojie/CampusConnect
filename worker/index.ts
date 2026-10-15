import { Hono } from "hono";
import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  createSessionToken,
  createEmailVerificationToken,
  hashEmailVerificationToken,
  hashPassword,
  hashSessionToken,
  serializeUser,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  type DatabaseUserRow,
  type PublicUser,
  validateSignupInput,
  verifyPassword,
} from "./auth";
import {
  defaultDatabaseClientFactory,
  withDatabase,
  type DatabaseClient,
  type DatabaseClientFactory,
} from "./db";
import {
  getResourceDetails,
  getResourceFilters,
  parsePositiveId,
  parseResourceSearch,
  searchResources,
} from "./resources";
import { getAnnouncements, parseAnnouncementQuery } from "./announcements";

type Bindings = {
  ASSETS: Fetcher;
  DB?: Hyperdrive;
  RESOURCE_IMAGES?: R2Bucket;
  APP_ENV?: string;
  PUBLIC_APP_ORIGIN?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
};

type AppEnv = {
  Bindings: Bindings;
  Variables: {
    user: PublicUser;
  };
};

type AppOptions = {
  createDatabaseClient?: DatabaseClientFactory;
  sendVerificationEmail?: VerificationEmailSender;
};

type LoginBody = {
  identifier?: unknown;
  password?: unknown;
};

type VerificationEmail = {
  email: string;
  token: string;
  userId: number;
};

type VerificationEmailSender = (email: VerificationEmail) => Promise<void>;

type VerificationBody = {
  token?: unknown;
};

type ResendVerificationBody = {
  email?: unknown;
};

const VERIFICATION_MESSAGE =
  "Check your Virginia Tech email to verify your account before signing in.";

const PUBLIC_API_PATHS = new Set([
  "/api/health",
  "/api/auth/signup",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/verify-email",
  "/api/auth/resend-verification",
]);

function databaseUnavailable(c: Context<AppEnv>) {
  return c.json({ ok: false, error: "Database is not configured" }, 503);
}

function getCookieOptions(c: Context<AppEnv>, expiresAt?: Date) {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: c.env.APP_ENV === "production",
    path: "/",
    ...(expiresAt
      ? { expires: expiresAt, maxAge: SESSION_TTL_SECONDS }
      : {}),
  };
}

function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE_NAME, {
    path: "/",
    secure: c.env.APP_ENV === "production",
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

async function readJson(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

function getVerificationLink(c: Context<AppEnv>, token: string): string {
  const origin = c.env.PUBLIC_APP_ORIGIN;
  if (!origin) {
    throw new Error("PUBLIC_APP_ORIGIN is not configured");
  }

  return `${origin.replace(/\/$/, "")}/#verify=${encodeURIComponent(token)}`;
}

function createDefaultVerificationEmailSender(
  c: Context<AppEnv>,
): VerificationEmailSender {
  return async ({ email, token, userId }) => {
    if (!c.env.RESEND_API_KEY || !c.env.RESEND_FROM_EMAIL) {
      throw new Error("Resend is not configured");
    }

    const verificationLink = getVerificationLink(c, token);
    const tokenHash = await hashEmailVerificationToken(token);
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `campusconnect-verification-${userId}-${tokenHash}`,
      },
      body: JSON.stringify({
        from: c.env.RESEND_FROM_EMAIL,
        to: [email],
        subject: "Verify your CampusConnect email",
        text: [
          "Verify your CampusConnect email",
          "",
          "Use the link below to confirm that you control this Virginia Tech email address:",
          verificationLink,
          "",
          "CampusConnect is a CS 5614 class project. Do not share sensitive information.",
        ].join("\n"),
        html: `
          <p>Verify your CampusConnect email.</p>
          <p><a href="${verificationLink}">Verify email</a></p>
          <p>CampusConnect is a CS 5614 class project. Do not share sensitive information.</p>
        `,
      }),
    });

    if (!response.ok) {
      throw new Error(`Resend returned HTTP ${response.status}`);
    }
  };
}

async function sendVerificationEmail(
  sender: VerificationEmailSender,
  email: VerificationEmail,
): Promise<void> {
  try {
    await sender(email);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    console.error(`Verification email could not be sent: ${reason}`);
  }
}

async function createSession(
  client: DatabaseClient,
  userId: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = await createSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const tokenHash = await hashSessionToken(token);

  await client.query(
    `
      INSERT INTO "Session" (user_id, token_hash, expires_at)
      VALUES ($1, $2::bytea, $3)
    `,
    [userId, tokenHash, expiresAt],
  );

  return { token, expiresAt };
}

async function findAuthenticatedUser(
  client: DatabaseClient,
  token: string,
): Promise<DatabaseUserRow | null> {
  const tokenHash = await hashSessionToken(token);
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

function setSessionCookie(
  c: Context<AppEnv>,
  token: string,
  expiresAt: Date,
): void {
  setCookie(c, SESSION_COOKIE_NAME, token, getCookieOptions(c, expiresAt));
}

async function requireAuthentication(
  c: Context<AppEnv>,
  next: Next,
  createDatabaseClient: DatabaseClientFactory,
) {
  const token = getCookie(c, SESSION_COOKIE_NAME);

  if (!token) {
    return c.json({ error: "Authentication required" }, 401);
  }
  if (!c.env.DB) {
    return databaseUnavailable(c);
  }

  try {
    const user = await withDatabase(
      c.env.DB.connectionString,
      createDatabaseClient,
      (client) => findAuthenticatedUser(client, token),
    );

    if (!user) {
      clearSessionCookie(c);
      return c.json({ error: "Your session has expired. Please log in again." }, 401);
    }

    c.set("user", serializeUser(user));
    return next();
  } catch {
    return c.json({ error: "Authentication service unavailable" }, 503);
  }
}

export function createApp(options: AppOptions = {}) {
  const createDatabaseClient =
    options.createDatabaseClient ?? defaultDatabaseClientFactory;
  const app = new Hono<AppEnv>();

  app.use("/api/*", async (c, next) => {
    const path = new URL(c.req.url).pathname;

    if (PUBLIC_API_PATHS.has(path)) {
      return next();
    }

    return requireAuthentication(c, next, createDatabaseClient);
  });

  const getEmailSender = (c: Context<AppEnv>): VerificationEmailSender =>
    options.sendVerificationEmail ?? createDefaultVerificationEmailSender(c);

  app.get("/api/health", async (c) => {
    if (!c.env.DB) {
      return c.json(
        {
          ok: false,
          database: "not-configured",
        },
        503,
      );
    }

    try {
      await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => client.query("SELECT 1"),
      );

      return c.json({
        ok: true,
        database: "connected",
      });
    } catch {
      return c.json(
        {
          ok: false,
          database: "unavailable",
        },
        503,
      );
    }
  });

  app.post("/api/auth/signup", async (c) => {
    const validation = validateSignupInput(await readJson(c));

    if (!validation.ok) {
      return c.json(
        { error: "Please correct the highlighted fields.", fieldErrors: validation.fieldErrors },
        400,
      );
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    const passwordHash = await hashPassword(validation.value.password);
    const verificationToken = await createEmailVerificationToken();
    const verificationTokenHash = await hashEmailVerificationToken(verificationToken);

    try {
      const result = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        async (client) => {
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
                VALUES ($1, $2, $3, $4, 'student', 20, CURRENT_DATE, FALSE, FALSE, $5, $6, NULL)
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
                  email_verified_at
              `,
              [
                validation.value.username,
                validation.value.email,
                passwordHash,
                validation.value.phoneNumber,
                validation.value.emailNotificationsOn,
                validation.value.textNotificationsOn,
              ],
            );
            const user = userResult.rows[0];

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
              [user.user_id, verificationTokenHash],
            );

            await client.query("COMMIT");

            return { user };
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        },
      );

      await sendVerificationEmail(getEmailSender(c), {
        email: result.user.email,
        token: verificationToken,
        userId: result.user.user_id,
      });
      return c.json({ message: VERIFICATION_MESSAGE }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return c.json({ error: "That username or email is already in use." }, 409);
      }

      return c.json({ error: "Unable to create the account right now." }, 503);
    }
  });

  app.post("/api/auth/verify-email", async (c) => {
    const body = (await readJson(c)) as VerificationBody | null;
    const token = typeof body?.token === "string" ? body.token.trim() : "";

    if (!token) {
      return c.json({ error: "That verification link is invalid." }, 400);
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const tokenHash = await hashEmailVerificationToken(token);
      const verified = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        async (client) => {
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
            const tokenRow = tokenResult.rows[0];

            if (!tokenRow) {
              await client.query("COMMIT");
              return false;
            }

            await client.query(
              `
                UPDATE "EmailVerificationToken"
                SET used_at = CURRENT_TIMESTAMP
                WHERE token_id = $1 AND used_at IS NULL
              `,
              [tokenRow.token_id],
            );
            await client.query(
              `
                UPDATE "User"
                SET email_verified_at = CURRENT_TIMESTAMP
                WHERE user_id = $1
              `,
              [tokenRow.user_id],
            );
            await client.query("COMMIT");
            return true;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        },
      );

      if (!verified) {
        return c.json({ error: "That verification link is invalid or has already been used." }, 400);
      }

      return c.json({ message: "Email verified. You can sign in now." });
    } catch {
      return c.json({ error: "Unable to verify the email right now." }, 503);
    }
  });

  app.post("/api/auth/resend-verification", async (c) => {
    const body = (await readJson(c)) as ResendVerificationBody | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";

    if (!email) {
      return c.json({ error: "Enter your email address." }, 400);
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const result = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        async (client) => {
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

            const token = await createEmailVerificationToken();
            const tokenHash = await hashEmailVerificationToken(token);
            await client.query(
              `
                INSERT INTO "EmailVerificationToken" (user_id, token_hash)
                VALUES ($1, $2::bytea)
              `,
              [user.user_id, tokenHash],
            );
            await client.query("COMMIT");

            return { email: user.email, token, userId: user.user_id };
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        },
      );

      if (result) {
        await sendVerificationEmail(getEmailSender(c), result);
      }

      return c.json({ message: VERIFICATION_MESSAGE }, 202);
    } catch {
      return c.json({ error: "Unable to resend the verification email right now." }, 503);
    }
  });

  app.post("/api/auth/login", async (c) => {
    const body = (await readJson(c)) as LoginBody | null;
    const identifier = typeof body?.identifier === "string" ? body.identifier.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";

    if (!identifier || !password) {
      return c.json({ error: "Enter your username or email and password." }, 400);
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const result = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        async (client) => {
          const userResult = await client.query<DatabaseUserRow>(
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
                email_verified_at,
                password_hash,
                is_banned
              FROM "User"
              WHERE LOWER(email) = LOWER($1) OR username = $1
              LIMIT 1
            `,
            [identifier],
          );
          const user = userResult.rows[0];

          if (
            !user ||
            user.is_banned ||
            !user.email_verified_at ||
            !(await verifyPassword(password, user.password_hash))
          ) {
            return null;
          }

          await client.query("BEGIN");
          try {
            const session = await createSession(client, user.user_id);
            await client.query("COMMIT");
            return { session, user };
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        },
      );

      if (!result) {
        return c.json({ error: "Invalid username/email or password." }, 401);
      }

      setSessionCookie(c, result.session.token, result.session.expiresAt);
      return c.json({ user: serializeUser(result.user) });
    } catch {
      return c.json({ error: "Unable to sign in right now." }, 503);
    }
  });

  app.post("/api/auth/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE_NAME);

    if (token && c.env.DB) {
      try {
        const tokenHash = await hashSessionToken(token);
        await withDatabase(
          c.env.DB.connectionString,
          createDatabaseClient,
          (client) =>
            client.query(
              `DELETE FROM "Session" WHERE token_hash = $1::bytea`,
              [tokenHash],
            ),
        );
      } catch {
        clearSessionCookie(c);
        return c.json({ error: "Unable to sign out right now." }, 503);
      }
    }

    clearSessionCookie(c);
    return c.body(null, 204);
  });

  app.get("/api/auth/me", (c) => c.json({ user: c.get("user") }));

  app.get("/api/resources", async (c) => {
    const search = parseResourceSearch(new URL(c.req.url).searchParams);

    if (!search.ok) {
      return c.json({ error: search.error }, 400);
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const result = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => searchResources(client, search.value),
      );
      return c.json(result);
    } catch {
      return c.json({ error: "Unable to load resources right now." }, 503);
    }
  });

  app.get("/api/resources/filters", async (c) => {
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const filters = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => getResourceFilters(client),
      );
      return c.json(filters);
    } catch {
      return c.json({ error: "Unable to load filters right now." }, 503);
    }
  });

  app.get("/api/resources/:id", async (c) => {
    const resourceId = parsePositiveId(c.req.param("id"));

    if (resourceId === null) {
      return c.json({ error: "Resource id must be a positive whole number." }, 400);
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const resource = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => getResourceDetails(client, resourceId),
      );

      if (!resource) {
        return c.json({ error: "Resource not found." }, 404);
      }

      return c.json({ resource });
    } catch {
      return c.json({ error: "Unable to load this resource right now." }, 503);
    }
  });

  app.get("/api/announcements", async (c) => {
    const query = parseAnnouncementQuery(new URL(c.req.url).searchParams);

    if (!query.ok) {
      return c.json({ error: query.error }, 400);
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const announcements = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => getAnnouncements(client, query.value),
      );
      return c.json({ announcements });
    } catch {
      return c.json({ error: "Unable to load announcements right now." }, 503);
    }
  });

  app.all("*", async (c) => {
    const response = await c.env.ASSETS.fetch(c.req.raw);

    if (response.status !== 404) {
      return response;
    }

    return c.notFound();
  });

  return app;
}

const app = createApp();

export default app;
