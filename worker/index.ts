import { Hono } from "hono";
import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  createSessionToken,
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

type Bindings = {
  ASSETS: Fetcher;
  DB?: Hyperdrive;
  RESOURCE_IMAGES?: R2Bucket;
  APP_ENV?: string;
  PUBLIC_APP_ORIGIN?: string;
  DEPLOYMENT_MARKER?: string;
  SESSION_SECRET?: string;
};

type AppEnv = {
  Bindings: Bindings;
  Variables: {
    user: PublicUser;
  };
};

type AppOptions = {
  createDatabaseClient?: DatabaseClientFactory;
};

type LoginBody = {
  identifier?: unknown;
  password?: unknown;
};

const SESSION_SMOKE_MESSAGE = "campusconnect:dev-session-smoke";
const PUBLIC_API_PATHS = new Set([
  "/api/health",
  "/api/dev/smoke",
  "/api/dev/r2-smoke",
  "/api/integration-smoke",
  "/api/dev/integration-smoke",
  "/api/auth/signup",
  "/api/auth/login",
  "/api/auth/logout",
]);

type IntegrationSmokeConfig = {
  r2Key: string;
  r2ExpectedValue: string;
  sql: string;
};

const INTEGRATION_SMOKE_CONFIG: Record<string, IntegrationSmokeConfig> = {
  dev: {
    r2Key: "dev-smoke/campusconnect.txt",
    r2ExpectedValue: "CampusConnect dev R2 smoke payload",
    sql: "SELECT message, created_at FROM dev_environment_smoke WHERE id = 1",
  },
  production: {
    r2Key: "prod-smoke/campusconnect.txt",
    r2ExpectedValue: "CampusConnect production R2 smoke payload",
    sql: "SELECT message, created_at FROM prod_environment_smoke WHERE id = 1",
  },
};

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

async function verifySessionSecret(secret?: string): Promise<boolean> {
  if (!secret || secret.length < 32) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const message = encoder.encode(SESSION_SMOKE_MESSAGE);
  const signature = await crypto.subtle.sign("HMAC", key, message);

  return crypto.subtle.verify("HMAC", key, signature, message);
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

  app.get("/api/health", async (c) => {
    if (!c.env.DB) {
      return c.json(
        {
          ok: false,
          environment: c.env.APP_ENV ?? "unknown",
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
        environment: c.env.APP_ENV ?? "unknown",
        database: "connected",
        deployment: c.env.DEPLOYMENT_MARKER ?? "not-set",
      });
    } catch {
      return c.json(
        {
          ok: false,
          environment: c.env.APP_ENV ?? "unknown",
          database: "unavailable",
          deployment: c.env.DEPLOYMENT_MARKER ?? "not-set",
        },
        503,
      );
    }
  });

  app.get("/api/dev/smoke", async (c) => {
    if (c.env.APP_ENV !== "dev" || !c.env.DB) {
      return c.notFound();
    }

    try {
      const result = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) =>
          client.query<{ message: string; created_at: string }>(
            "SELECT message, created_at FROM dev_environment_smoke WHERE id = 1",
          ),
      );

      if (result.rowCount !== 1) {
        return c.json({ ok: false, error: "Smoke migration has not run" }, 503);
      }

      return c.json({ ok: true, row: result.rows[0] });
    } catch {
      return c.json({ ok: false, error: "Smoke table is unavailable" }, 503);
    }
  });

  app.get("/api/dev/r2-smoke", async (c) => {
    if (c.env.APP_ENV !== "dev" || !c.env.RESOURCE_IMAGES) {
      return c.notFound();
    }

    const key = `_smoke/${crypto.randomUUID()}.txt`;
    const expected = "CampusConnect R2 smoke test";

    try {
      await c.env.RESOURCE_IMAGES.put(key, expected);
      const object = await c.env.RESOURCE_IMAGES.get(key);
      const actual = object ? await object.text() : null;

      return c.json({ ok: actual === expected });
    } finally {
      await c.env.RESOURCE_IMAGES.delete(key);
    }
  });

  async function integrationSmoke(c: Context<AppEnv>) {
    const smokeConfig = c.env.APP_ENV
      ? INTEGRATION_SMOKE_CONFIG[c.env.APP_ENV]
      : undefined;

    if (!smokeConfig || !c.env.DB || !c.env.RESOURCE_IMAGES) {
      return c.notFound();
    }

    const requestedKey = c.req.query("key");
    if (requestedKey !== smokeConfig.r2Key) {
      return c.json({ ok: false, error: "Unsupported smoke-test key" }, 400);
    }

    const sessionConfigured = Boolean(c.env.SESSION_SECRET);
    const sessionVerified = await verifySessionSecret(c.env.SESSION_SECRET);

    try {
      const result = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        async (client) => {
          const object = await c.env.RESOURCE_IMAGES!.get(smokeConfig.r2Key);
          const r2Value = object ? (await object.text()).trim() : null;
          const databaseResult = await client.query<{
            message: string;
            created_at: string;
          }>(smokeConfig.sql);

          return { databaseResult, r2Value };
        },
      );
      const databaseRow = result.databaseResult.rows[0] ?? null;
      const r2Ok = result.r2Value === smokeConfig.r2ExpectedValue;
      const databaseOk = result.databaseResult.rowCount === 1;

      return c.json({
        ok: r2Ok && databaseOk && sessionVerified,
        environment: c.env.APP_ENV,
        session: {
          configured: sessionConfigured,
          verified: sessionVerified,
        },
        r2: {
          key: smokeConfig.r2Key,
          expected: smokeConfig.r2ExpectedValue,
          actual: result.r2Value,
          ok: r2Ok,
        },
        sql: {
          query: smokeConfig.sql,
          row: databaseRow,
          ok: databaseOk,
        },
      });
    } catch {
      return c.json(
        {
          ok: false,
          error: "The combined R2 and database smoke test failed",
          session: {
            configured: sessionConfigured,
            verified: sessionVerified,
          },
          r2: { key: smokeConfig.r2Key },
          sql: { query: smokeConfig.sql },
        },
        503,
      );
    }
  }

  app.get("/api/integration-smoke", integrationSmoke);
  app.get("/api/dev/integration-smoke", (c) => {
    if (c.env.APP_ENV !== "dev") {
      return c.notFound();
    }

    return integrationSmoke(c);
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
                  text_notifications_on
                )
                VALUES ($1, $2, $3, $4, 'student', 20, CURRENT_DATE, FALSE, FALSE, TRUE, FALSE)
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
                  text_notifications_on
              `,
              [
                validation.value.username,
                validation.value.email,
                passwordHash,
                validation.value.phoneNumber,
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

            const session = await createSession(client, user.user_id);
            await client.query("COMMIT");

            return { session, user };
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        },
      );

      setSessionCookie(c, result.session.token, result.session.expiresAt);
      return c.json({ user: serializeUser(result.user) }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return c.json({ error: "That username or email is already in use." }, 409);
      }

      return c.json({ error: "Unable to create the account right now." }, 503);
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
                password_hash,
                is_banned
              FROM "User"
              WHERE LOWER(email) = LOWER($1) OR username = $1
              LIMIT 1
            `,
            [identifier],
          );
          const user = userResult.rows[0];

          if (!user || user.is_banned || !(await verifyPassword(password, user.password_hash))) {
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
