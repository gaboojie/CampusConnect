import { Hono } from "hono";
import type { Context } from "hono";
import { Client } from "pg";

type Bindings = {
  ASSETS: Fetcher;
  DB?: Hyperdrive;
  RESOURCE_IMAGES?: R2Bucket;
  APP_ENV?: string;
  PUBLIC_APP_ORIGIN?: string;
  DEPLOYMENT_MARKER?: string;
  SESSION_SECRET?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

const SESSION_SMOKE_MESSAGE = "campusconnect:dev-session-smoke";

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

  const client = new Client({ connectionString: c.env.DB.connectionString });

  try {
    await client.connect();
    await client.query("SELECT 1");

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
  } finally {
    await client.end();
  }
});

app.get("/api/dev/smoke", async (c) => {
  if (c.env.APP_ENV !== "dev" || !c.env.DB) {
    return c.notFound();
  }

  const client = new Client({ connectionString: c.env.DB.connectionString });

  try {
    await client.connect();
    const result = await client.query<{
      message: string;
      created_at: string;
    }>(
      "SELECT message, created_at FROM dev_environment_smoke WHERE id = 1",
    );

    if (result.rowCount !== 1) {
      return c.json({ ok: false, error: "Smoke migration has not run" }, 503);
    }

    return c.json({ ok: true, row: result.rows[0] });
  } catch {
    return c.json(
      { ok: false, error: "Smoke table is unavailable" },
      503,
    );
  } finally {
    await client.end();
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

async function integrationSmoke(
  c: Context<{ Bindings: Bindings }>,
) {
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

  const client = new Client({ connectionString: c.env.DB.connectionString });
  const sessionConfigured = Boolean(c.env.SESSION_SECRET);
  const sessionVerified = await verifySessionSecret(c.env.SESSION_SECRET);

  try {
    const object = await c.env.RESOURCE_IMAGES.get(smokeConfig.r2Key);
    const r2Value = object ? (await object.text()).trim() : null;

    await client.connect();
    const result = await client.query<{
      message: string;
      created_at: string;
    }>(smokeConfig.sql);
    const databaseRow = result.rows[0] ?? null;

    const r2Ok = r2Value === smokeConfig.r2ExpectedValue;
    const databaseOk = result.rowCount === 1;

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
        actual: r2Value,
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
  } finally {
      await client.end();
  }
}

app.get("/api/integration-smoke", integrationSmoke);
app.get("/api/dev/integration-smoke", (c) => {
  if (c.env.APP_ENV !== "dev") {
    return c.notFound();
  }

  return integrationSmoke(c);
});

app.all("*", async (c) => {
  const response = await c.env.ASSETS.fetch(c.req.raw);

  if (response.status !== 404) {
    return response;
  }

  return c.notFound();
});

export default app;
