import { describe, expect, it } from "vitest";
import { createApp } from "../worker/index";
import {
  createEmailVerificationToken,
  hashEmailVerificationToken,
  hashPassword,
  hashSessionToken,
  isVtEmail,
  type DatabaseUserRow,
  type SignupInput,
  validateChangePasswordInput,
  validateSignupInput,
  verifyPassword,
} from "../worker/auth";
import type { DatabaseClient, DatabaseQueryResult } from "../worker/db";

type FakeSession = {
  userId: number;
  tokenHash: string;
  expiresAt: Date;
};

type FakeVerificationToken = {
  tokenId: number;
  userId: number;
  tokenHash: string;
  createdAt: Date;
  usedAt: Date | null;
};

class FakeDatabase {
  users: Array<DatabaseUserRow & { password_hash: string | null }> = [];
  sessions: FakeSession[] = [];
  verificationTokens: FakeVerificationToken[] = [];
  nextUserId = 1;
  nextTokenId = 1;

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
      const [username, email, passwordHash, phoneNumber, emailNotificationsOn, textNotificationsOn] = values as [
        string,
        string,
        string,
        string | null,
        boolean,
        boolean,
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
        email_notifications_on: emailNotificationsOn,
        text_notifications_on: textNotificationsOn,
        can_add_resources: true,
        email_verified_at: null,
        is_banned: false,
      } satisfies DatabaseUserRow & { password_hash: string | null };

      this.database.users.push(user);
      return { rows: [user] as T[], rowCount: 1 };
    }

    if (query.startsWith("INSERT INTO \"CreditTransaction\"")) {
      return { rows: [], rowCount: 1 };
    }

    if (query.startsWith("INSERT INTO \"EmailVerificationToken\"")) {
      const [userId, tokenHash] = values as [number, string];
      this.database.verificationTokens.push({
        tokenId: this.database.nextTokenId++,
        userId,
        tokenHash,
        createdAt: new Date(),
        usedAt: null,
      });
      return { rows: [], rowCount: 1 };
    }

    if (query.startsWith("SELECT token_id, user_id")) {
      const tokenHash = String(values[0]);
      const token = this.database.verificationTokens.find(
        (candidate) => candidate.tokenHash === tokenHash && !candidate.usedAt,
      );
      return {
        rows: token
          ? [{ token_id: token.tokenId, user_id: token.userId } as T]
          : [],
        rowCount: token ? 1 : 0,
      };
    }

    if (query.startsWith("UPDATE \"EmailVerificationToken\"")) {
      const [value] = values as [number];
      if (query.includes("token_id = $1")) {
        const token = this.database.verificationTokens.find(
          (candidate) => candidate.tokenId === value && !candidate.usedAt,
        );
        if (token) token.usedAt = new Date();
      } else {
        for (const token of this.database.verificationTokens) {
          if (token.userId === value && !token.usedAt) token.usedAt = new Date();
        }
      }
      return { rows: [], rowCount: 1 };
    }

    if (query.startsWith("UPDATE \"User\"")) {
      const [userId] = values as [number];
      const user = this.database.users.find((candidate) => candidate.user_id === userId);
      if (user) user.email_verified_at = new Date();
      return { rows: [], rowCount: user ? 1 : 0 };
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
    emailNotificationsOn: true,
    textNotificationsOn: false,
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

  it("validates password changes", () => {
    const valid = {
      currentPassword: "old-password",
      newPassword: "new-password",
      confirmPassword: "new-password",
    };

    expect(validateChangePasswordInput(valid)).toEqual({ ok: true, value: valid });

    const result = validateChangePasswordInput({
      currentPassword: "",
      newPassword: "short",
      confirmPassword: "different",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors.currentPassword).toBeDefined();
      expect(result.fieldErrors.newPassword).toBeDefined();
      expect(result.fieldErrors.confirmPassword).toBeDefined();
    }

    const same = validateChangePasswordInput({ ...valid, newPassword: "old-password", confirmPassword: "old-password" });
    expect(same.ok).toBe(false);
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

  it("creates and hashes random email verification tokens", async () => {
    const first = await createEmailVerificationToken();
    const second = await createEmailVerificationToken();

    expect(first).not.toBe(second);
    expect(first).toHaveLength(43);
    expect(await hashEmailVerificationToken(first)).toMatch(/^\\x[0-9a-f]{64}$/);
    expect(await hashEmailVerificationToken(first)).not.toBe(first);
  });
});

describe("authentication routes", () => {
  it("requires email verification before login and then supports sessions", async () => {
    const database = new FakeDatabase();
    const sentEmails: Array<{ email: string; token: string; userId: number }> = [];
    const app = createApp({
      createDatabaseClient: () => database.createClient(),
      sendVerificationEmail: async (email) => {
        sentEmails.push(email);
      },
    });
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
    expect(signup.headers.get("set-cookie")).toBeNull();
    expect((await signup.json()).message).toContain("Check your Virginia Tech email");
    expect(sentEmails).toHaveLength(1);
    expect(database.users[0].email_verified_at).toBeNull();
    expect(database.verificationTokens[0].tokenHash).not.toBe(sentEmails[0].token);

    const unverifiedMe = await app.request(
      "http://localhost/api/auth/me",
      {},
      environment,
    );
    expect(unverifiedMe.status).toBe(401);

    const unverifiedLogin = await app.request(
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
    expect(unverifiedLogin.status).toBe(401);

    const verification = await app.request(
      "http://localhost/api/auth/verify-email",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: sentEmails[0].token }),
      },
      environment,
    );
    expect(verification.status).toBe(200);
    expect(database.users[0].email_verified_at).not.toBeNull();

    const usedVerification = await app.request(
      "http://localhost/api/auth/verify-email",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: sentEmails[0].token }),
      },
      environment,
    );
    expect(usedVerification.status).toBe(400);

    const invalidVerification = await app.request(
      "http://localhost/api/auth/verify-email",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "not-a-real-token" }),
      },
      environment,
    );
    expect(invalidVerification.status).toBe(400);

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
    const session = sessionCookie(login);
    expect(session.value).toContain("campusconnect_session=");
    expect(session.header).toContain("HttpOnly");

    const me = await app.request(
      "http://localhost/api/auth/me",
      { headers: { cookie: session.value } },
      environment,
    );
    expect(me.status).toBe(200);
    expect((await me.json()).user.username).toBe("maya_r");

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

  it("invalidates older verification links when resending", async () => {
    const database = new FakeDatabase();
    const sentEmails: Array<{ email: string; token: string; userId: number }> = [];
    const app = createApp({
      createDatabaseClient: () => database.createClient(),
      sendVerificationEmail: async (email) => {
        sentEmails.push(email);
      },
    });
    const environment = testEnvironment(database);

    await app.request(
      "http://localhost/api/auth/signup",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validSignup()),
      },
      environment,
    );
    const originalToken = sentEmails[0].token;

    const resend = await app.request(
      "http://localhost/api/auth/resend-verification",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "MAYA.R@VT.EDU" }),
      },
      environment,
    );
    expect(resend.status).toBe(202);
    expect(sentEmails).toHaveLength(2);

    const unknownResend = await app.request(
      "http://localhost/api/auth/resend-verification",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "unknown@vt.edu" }),
      },
      environment,
    );
    expect(unknownResend.status).toBe(202);
    expect(sentEmails).toHaveLength(2);

    const oldVerification = await app.request(
      "http://localhost/api/auth/verify-email",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: originalToken }),
      },
      environment,
    );
    expect(oldVerification.status).toBe(400);

    const activeToken = database.verificationTokens.find(
      (token) => !token.usedAt,
    );
    expect(activeToken).toBeDefined();
    if (activeToken) activeToken.createdAt = new Date(0);

    const currentVerification = await app.request(
      "http://localhost/api/auth/verify-email",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: sentEmails[1].token }),
      },
      environment,
    );
    expect(currentVerification.status).toBe(200);
  });

  it("keeps the account when sending the verification email fails", async () => {
    const database = new FakeDatabase();
    const app = createApp({
      createDatabaseClient: () => database.createClient(),
      sendVerificationEmail: async () => {
        throw new Error("mail provider unavailable");
      },
    });
    const response = await app.request(
      "http://localhost/api/auth/signup",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validSignup()),
      },
      testEnvironment(database),
    );

    expect(response.status).toBe(201);
    expect(database.users).toHaveLength(1);
    expect(database.verificationTokens).toHaveLength(1);
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
        email_verified_at: null,
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
