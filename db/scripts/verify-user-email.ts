import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import type { DatabaseClient } from "../client";

type VerificationEnvironment = "dev" | "prod";

export type VerifyUserEmailOptions = {
  environment: VerificationEnvironment;
  username: string;
};

type UserRow = {
  user_id: number;
  username: string;
  email: string;
  email_verified_at: string | Date | null;
  is_banned: boolean;
  is_account_deleted: boolean;
};

export const VERIFY_USER_EMAIL_USAGE = `Usage:
  npm run verify:user-email -- --user <username> --env <dev|prod>

Options:
  --user <username>  Target exactly one username.
  --env <dev|prod>   Choose the .env file and database.
  --help             Show this help text.`;

const OPTION_NAMES = new Set(["--user", "--env", "--help"]);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const databaseEnvironmentVariable = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB";

function argumentValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.\n\n${VERIFY_USER_EMAIL_USAGE}`);
  }
  return value.trim();
}

export function parseVerifyUserEmailArgs(args: readonly string[]): VerifyUserEmailOptions {
  if (args.includes("--help") || args.includes("-h")) {
    throw new Error(VERIFY_USER_EMAIL_USAGE);
  }

  let username: string | undefined;
  let environment: VerificationEnvironment | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];

    if (!option.startsWith("--") || !OPTION_NAMES.has(option)) {
      throw new Error(`Unknown or misplaced argument "${option}".\n\n${VERIFY_USER_EMAIL_USAGE}`);
    }

    switch (option) {
      case "--user":
        if (username !== undefined) {
          throw new Error(`--user may only be provided once.\n\n${VERIFY_USER_EMAIL_USAGE}`);
        }
        username = argumentValue(args, index, option);
        index += 1;
        break;
      case "--env": {
        if (environment !== undefined) {
          throw new Error(`--env may only be provided once.\n\n${VERIFY_USER_EMAIL_USAGE}`);
        }
        const value = argumentValue(args, index, option);
        if (value !== "dev" && value !== "prod") {
          throw new Error(`--env must be dev or prod.\n\n${VERIFY_USER_EMAIL_USAGE}`);
        }
        environment = value;
        index += 1;
        break;
      }
      case "--help":
        break;
    }
  }

  if (!username) throw new Error(`--user is required.\n\n${VERIFY_USER_EMAIL_USAGE}`);
  if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) {
    throw new Error("--user must be 3–32 letters, numbers, or underscores.\n\n" + VERIFY_USER_EMAIL_USAGE);
  }
  if (!environment) throw new Error(`--env is required.\n\n${VERIFY_USER_EMAIL_USAGE}`);

  return { environment, username };
}

function getDatabaseUrl(environment: VerificationEnvironment): string {
  const environmentFile = join(projectRoot, `.env.${environment}`);

  if (!existsSync(environmentFile)) {
    throw new Error(
      `Missing ${environmentFile}. Copy .env.${environment}.example to .env.${environment} and configure it before running this command.`,
    );
  }

  // Load only the selected environment file. The connection string is never printed.
  delete process.env[databaseEnvironmentVariable];
  process.loadEnvFile(environmentFile);

  const databaseUrl = process.env[databaseEnvironmentVariable];
  if (!databaseUrl) {
    throw new Error(`${databaseEnvironmentVariable} is missing from .env.${environment}.`);
  }
  return databaseUrl;
}

export async function verifyUserEmail(
  client: Pick<DatabaseClient, "query">,
  username: string,
): Promise<{ user: UserRow; changed: boolean }> {
  await client.query("BEGIN");

  try {
    const result = await client.query<UserRow>(
      `
        SELECT user_id, username, email, email_verified_at, is_banned, is_account_deleted
        FROM "User"
        WHERE username = $1
        FOR UPDATE
      `,
      [username],
    );
    const user = result.rows[0];

    if (!user) {
      throw new Error(`No user found for username "${username}".`);
    }
    if (user.is_banned) {
      throw new Error(`Cannot verify banned user "${username}".`);
    }
    if (user.is_account_deleted) {
      throw new Error(`Cannot verify deleted user "${username}".`);
    }
    if (user.email_verified_at) {
      await client.query("COMMIT");
      return { user, changed: false };
    }

    const updated = await client.query<{ email_verified_at: string | Date }>(
      `
        UPDATE "User"
        SET email_verified_at = CURRENT_TIMESTAMP
        WHERE user_id = $1 AND email_verified_at IS NULL
        RETURNING email_verified_at
      `,
      [user.user_id],
    );
    const verifiedAt = updated.rows[0]?.email_verified_at;
    if (!verifiedAt) {
      throw new Error(`Unable to verify user "${username}".`);
    }

    // Invalidate any outstanding mailbox token because this account was verified
    // through the explicit administrative PostgreSQL command.
    await client.query(
      `
        UPDATE "EmailVerificationToken"
        SET used_at = CURRENT_TIMESTAMP
        WHERE user_id = $1 AND used_at IS NULL
      `,
      [user.user_id],
    );
    await client.query("COMMIT");

    return {
      user: { ...user, email_verified_at: verifiedAt },
      changed: true,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main(): Promise<void> {
  let options: VerifyUserEmailOptions;

  try {
    options = parseVerifyUserEmailArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === VERIFY_USER_EMAIL_USAGE) {
      console.log(message);
      return;
    }
    throw error;
  }

  const client = new Client({ connectionString: getDatabaseUrl(options.environment) });
  await client.connect();

  try {
    const result = await verifyUserEmail(client, options.username);
    const state = result.changed ? "verified" : "was already verified";
    console.log(`${result.user.username} (${result.user.email}) ${state} in ${options.environment}.`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
