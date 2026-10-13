import { describe, expect, it } from "vitest";
import { createApp } from "../worker/index";
import {
  hashPassword,
  hashSessionToken,
  isVtEmail,
  type DatabaseUserRow,
  type SignupInput,
  validateSignupInput,
  verifyPassword,
} from "../worker/auth";
import type { DatabaseClient, DatabaseQueryResult } from "../worker/db";

type FakeSession = {
  userId: number;
  tokenHash: string;
  expiresAt: Date;
};

class FakeDatabase {
  users: Array<DatabaseUserRow & { password_hash: string | null }> = [];
  sessions: FakeSession[] = [];
  nextUserId = 1;

  createClient(): DatabaseClient {
    return new FakeClient(this);
  }
}

class FakeClient implements DatabaseClient {
  constructor(private readonly database: FakeDatabase) {}

  async connect(): Promise<void> {}

  async end(): Promise<void> {}

  async query<T = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<DatabaseQueryResult<T>> {
    const query = text.replace(/\s+/g, " ").trim();

    if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }

    if (query === "SELECT 1") {
      return { rows: [], rowCount: 1 };
    }

    if (query.startsWith("INSERT INTO \"User\"")) {
      const [username, email, passwordHash, phoneNumber] = values as [
        string,
        string,
        string,
        string | null,
      ];

      if (
        this.database.users.some(
          (user) => user.username === username || user.email === email,
        )
      ) {
        const error = new Error("duplicate user") as Error & { code: string };
        error.code = "23505";
        throw error;
      }

      const createdAt = new Date();
      const user = {
        user_id: this.database.nextUserId++,
        username,
        email,
        password_hash: passwordHash,
        phone_number: phoneNumber,
        role: "student",
        created_at: createdAt,
        credit_balance: 20,
        credit_last_reset: createdAt,
        email_notifications_on: true,
        text_notifications_on: false,
        is_banned: false,
      } satisfies DatabaseUserRow & { password_hash: string | null };

      this.database.users.push(user);
      return { rows: [user] as T[], rowCount: 1 };
    }

    if (query.startsWith("INSERT INTO \"CreditTransaction\"")) {
      return { rows: [], rowCount: 1 };
    }

    if (query.startsWith("INSERT INTO \"Session\"")) {
      const [userId, tokenHash, expiresAt] = values as [number, string, Date];
      this.database.sessions.push({ userId, tokenHash, expiresAt });
      return { rows: [], rowCount: 1 };
    }

    if (query.startsWith("SELECT u.user_id")) {
      const tokenHash = String(values[0]);
      const session = this.database.sessions.find(
        (candidate) => candidate.tokenHash === tokenHash,
      );
      const user = session
        ? this.database.users.find((candidate) => candidate.user_id === session.userId)
        : undefined;
      const row =
        session &&
        session.expiresAt > new Date() &&
        user &&
        !user.is_banned
          ? user
          : undefined;

      return { rows: row ? [row as T] : [], rowCount: row ? 1 : 0 };
    }

    if (query.startsWith("SELECT user_id")) {
      const identifier = String(values[0]);
      const user = this.database.users.find(
        (candidate) =>
          candidate.email.toLowerCase() === identifier.toLowerCase() ||
          candidate.username === identifier,
      );

      return { rows: user ? [user as T] : [], rowCount: user ? 1 : 0 };
    }

    if (query.startsWith("DELETE FROM \"Session\"")) {
      const tokenHash = String(values[0]);
      this.database.sessions = this.database.sessions.filter(
        (session) => session.tokenHash !== tokenHash,
      );
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unhandled fake query: ${query}`);
  }
}

function validSignup(overrides: Partial<SignupInput> = {}): SignupInput {
  return {
    username: "maya_r",
    email: "maya.r@vt.edu",
    password: "correct horse battery staple",
    confirmPassword: "correct horse battery staple",
    phoneNumber: null,
    ...overrides,
  };
}

function testEnvironment(database: FakeDatabase) {
  return {
    APP_ENV: "dev",
    DB: { connectionString: "fake://database" },
    ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
    createDatabaseClient: () => database.createClient(),
  };
}

function sessionCookie(response: Response): { header: string; value: string } {
  const header = response.headers.get("set-cookie") ?? "";
  return { header, value: header.split(";", 1)[0] };
}

describe("authentication helpers", () => {
  it("accepts only VT email addresses", () => {
    expect(isVtEmail("student@vt.edu")).toBe(true);
    expect(isVtEmail("STUDENT@VT.EDU")).toBe(true);
    expect(isVtEmail("student@example.com")).toBe(false);
    expect(isVtEmail("student@vt.edu.example.com")).toBe(false);
  });

  it("validates signup fields", () => {
    const result = validateSignupInput({
      ...validSignup(),
      email: "student@example.com",
      confirmPassword: "different",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors.email).toBeDefined();
      expect(result.fieldErrors.confirmPassword).toBeDefined();
    }
  });

  it("hashes and verifies passwords while rejecting malformed hashes", async () => {
    const passwordHash = await hashPassword("correct horse battery staple");

    expect(await verifyPassword("correct horse battery staple", passwordHash)).toBe(true);
    expect(await verifyPassword("wrong password", passwordHash)).toBe(false);
    expect(await verifyPassword("anything", "not-a-password-hash")).toBe(false);
  });

  it("hashes session tokens as PostgreSQL bytea values", async () => {
    const first = await hashSessionToken("session-token");
    const second = await hashSessionToken("session-token");

    expect(first).toBe(second);
    expect(first).toMatch(/^\\x[0-9a-f]{64}$/);
  });
});

describe("authentication routes", () => {
  it("supports signup, login session lookup, logout, and protected routes", async () => {
    const database = new FakeDatabase();
    const app = createApp({ createDatabaseClient: () => database.createClient() });
    const environment = testEnvironment(database);

    const signup = await app.request(
      "http://localhost/api/auth/signup",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validSignup()),
      },
      environment,
    );

    expect(signup.status).toBe(201);
    const session = sessionCookie(signup);
    expect(session.value).toContain("campusconnect_session=");
    expect(session.header).toContain("HttpOnly");

    const me = await app.request(
      "http://localhost/api/auth/me",
      { headers: { cookie: session.value } },
      environment,
    );
    expect(me.status).toBe(200);
    expect((await me.json()).user.username).toBe("maya_r");

    const login = await app.request(
      "http://localhost/api/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          identifier: "maya.r@vt.edu",
          password: "correct horse battery staple",
        }),
      },
      environment,
    );
    expect(login.status).toBe(200);

    const invalidLogin = await app.request(
      "http://localhost/api/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: "maya_r", password: "wrong password" }),
      },
      environment,
    );
    expect(invalidLogin.status).toBe(401);

    const protectedRequest = await app.request(
      "http://localhost/api/private-resource",
      {},
      environment,
    );
    expect(protectedRequest.status).toBe(401);

    const logout = await app.request(
      "http://localhost/api/auth/logout",
      { method: "POST", headers: { cookie: session.value } },
      environment,
    );
    expect(logout.status).toBe(204);

    const afterLogout = await app.request(
      "http://localhost/api/auth/me",
      { headers: { cookie: session.value } },
      environment,
    );
    expect(afterLogout.status).toBe(401);
  });

  it("rejects non-VT signup and duplicate accounts", async () => {
    const database = new FakeDatabase();
    const app = createApp({ createDatabaseClient: () => database.createClient() });
    const environment = testEnvironment(database);

    const invalidSignup = await app.request(
      "http://localhost/api/auth/signup",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validSignup({ email: "student@example.com" })),
      },
      environment,
    );
    expect(invalidSignup.status).toBe(400);

    const signupBody = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validSignup()),
    };
    expect((await app.request("http://localhost/api/auth/signup", signupBody, environment)).status).toBe(201);
    expect((await app.request("http://localhost/api/auth/signup", signupBody, environment)).status).toBe(409);
  });

  it("rejects invalid, expired, and banned sessions", async () => {
    const database = new FakeDatabase();
    const app = createApp({ createDatabaseClient: () => database.createClient() });
    const environment = testEnvironment(database);
    const passwordHash = await hashPassword("correct horse battery staple");

    database.users.push({
      user_id: 1,
      username: "banned_user",
      email: "banned@vt.edu",
      password_hash: passwordHash,
      phone_number: null,
      role: "student",
      created_at: new Date(),
      credit_balance: 20,
      credit_last_reset: new Date(),
      email_notifications_on: true,
      text_notifications_on: false,
      is_banned: true,
    });

    const bannedLogin = await app.request(
      "http://localhost/api/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: "banned@vt.edu", password: "correct horse battery staple" }),
      },
      environment,
    );
    expect(bannedLogin.status).toBe(401);

    const expiredToken = "expired-token";
    database.sessions.push({
      userId: 1,
      tokenHash: await hashSessionToken(expiredToken),
      expiresAt: new Date(Date.now() - 1_000),
    });
    const expiredSession = await app.request(
      "http://localhost/api/auth/me",
      { headers: { cookie: `campusconnect_session=${expiredToken}` } },
      environment,
    );
    expect(expiredSession.status).toBe(401);
  });

  it("keeps health public", async () => {
    const database = new FakeDatabase();
    const app = createApp({ createDatabaseClient: () => database.createClient() });
    const response = await app.request(
      "http://localhost/api/health",
      {},
      testEnvironment(database),
    );

    expect(response.status).toBe(200);
  });
});
