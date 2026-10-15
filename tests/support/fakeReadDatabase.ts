import { hashSessionToken, type DatabaseUserRow } from "../../worker/auth";
import type { DatabaseClient, DatabaseQueryResult } from "../../worker/db";

export const SESSION_TOKEN = "test-session-token";

export type RecordedQuery = {
  text: string;
  values: readonly unknown[];
};

type Responder = {
  match: (query: string) => boolean;
  rows: (values: readonly unknown[]) => unknown[];
};

const sessionUser: DatabaseUserRow = {
  user_id: 6,
  username: "maya_r",
  email: "maya.r@vt.edu",
  phone_number: null,
  role: "student",
  created_at: new Date("2026-08-24T10:00:00Z"),
  credit_balance: 20,
  credit_last_reset: new Date("2026-10-01T00:00:00Z"),
  email_notifications_on: true,
  text_notifications_on: false,
  can_add_resources: false,
  is_banned: false,
};

// A fake database for read-only endpoints. It answers the session lookup used by
// the auth middleware, records every other query, and replies with canned rows
// chosen by a matcher on the normalized SQL text.
export class FakeReadDatabase {
  queries: RecordedQuery[] = [];
  private responders: Responder[] = [];
  failWith: Error | null = null;

  respond(match: string | ((query: string) => boolean), rows: unknown[] | ((values: readonly unknown[]) => unknown[])) {
    this.responders.push({
      match: typeof match === "string" ? (query) => query.startsWith(match) : match,
      rows: typeof rows === "function" ? rows : () => rows,
    });
    return this;
  }

  createClient(): DatabaseClient {
    return {
      connect: async () => {},
      end: async () => {},
      query: async <T = Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<DatabaseQueryResult<T>> => {
        const query = text.replace(/\s+/g, " ").trim();

        if (query.startsWith("SELECT u.user_id")) {
          const valid = values[0] === (await hashSessionToken(SESSION_TOKEN));
          return { rows: valid ? [sessionUser as T] : [], rowCount: valid ? 1 : 0 };
        }

        this.queries.push({ text: query, values });

        if (this.failWith) {
          throw this.failWith;
        }

        const responder = this.responders.find((candidate) => candidate.match(query));
        if (!responder) {
          throw new Error(`Unhandled fake query: ${query}`);
        }

        const rows = responder.rows(values) as T[];
        return { rows, rowCount: rows.length };
      },
    };
  }

  environment() {
    return {
      APP_ENV: "dev",
      DB: { connectionString: "fake://database" },
      ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
    };
  }
}

export const authHeaders = { cookie: `campusconnect_session=${SESSION_TOKEN}` };

export function expectReadOnly(queries: RecordedQuery[]) {
  for (const { text } of queries) {
    if (!/^(SELECT|WITH)\b/i.test(text) || /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b/i.test(text)) {
      throw new Error(`Expected a read-only query, got: ${text}`);
    }
  }
}
