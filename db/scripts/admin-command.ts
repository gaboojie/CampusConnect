import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";

type AdminEnvironment = "dev" | "prod";
type RequestedRole = "user" | "admin";

export type AdminCommandAction =
  | { kind: "ban"; value: boolean }
  | { kind: "delete" }
  | { kind: "can_add_resources"; value: boolean }
  | { kind: "role"; value: RequestedRole };

export type AdminCommandOptions = {
  environment: AdminEnvironment;
  username: string;
  action: AdminCommandAction;
};

type UserRow = {
  user_id: number;
  username: string;
  email: string;
  role: string;
  is_banned: boolean;
  can_add_resources: boolean;
};

type ResourceRow = {
  resource_id: number;
  resource_image_id: number | null;
};

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const databaseEnvironmentVariable = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB";

export const ADMIN_COMMAND_USAGE = `Usage:
  npm run admin:command -- --user <username> --ban <true|false> --env <dev|prod>
  npm run admin:command -- --user <username> --delete --env <dev|prod>
  npm run admin:command -- --user <username> --can_add_resources <true|false> --env <dev|prod>
  npm run admin:command -- --user <username> --role <admin|user> --env <dev|prod>

Options:
  --user <username>                 Target exactly one username.
  --ban <true|false>                Ban or unban the user.
  --delete                          Permanently delete the user and dependent rows.
  --can_add_resources <true|false>  Allow or disallow resource listings.
  --role <admin|user>               Set the database role.
  --env <dev|prod>                  Choose the .env file and database.
  --help                            Show this help text.`;

const OPTION_NAMES = new Set([
  "--user",
  "--ban",
  "--delete",
  "--can_add_resources",
  "--role",
  "--env",
  "--help",
]);

function argumentValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.\n\n${ADMIN_COMMAND_USAGE}`);
  }
  return value.trim();
}

function parseBoolean(value: string, option: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${option} must be true or false.\n\n${ADMIN_COMMAND_USAGE}`);
}

export function parseAdminCommandArgs(args: readonly string[]): AdminCommandOptions {
  if (args.includes("--help") || args.includes("-h")) {
    throw new Error(ADMIN_COMMAND_USAGE);
  }

  let username: string | undefined;
  let environment: AdminEnvironment | undefined;
  let action: AdminCommandAction | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];

    if (!option.startsWith("--") || !OPTION_NAMES.has(option)) {
      throw new Error(`Unknown or misplaced argument "${option}".\n\n${ADMIN_COMMAND_USAGE}`);
    }

    switch (option) {
      case "--user": {
        if (username !== undefined) throw new Error(`--user may only be provided once.\n\n${ADMIN_COMMAND_USAGE}`);
        username = argumentValue(args, index, option);
        index += 1;
        break;
      }
      case "--env": {
        if (environment !== undefined) throw new Error(`--env may only be provided once.\n\n${ADMIN_COMMAND_USAGE}`);
        const value = argumentValue(args, index, option);
        if (value !== "dev" && value !== "prod") {
          throw new Error(`--env must be dev or prod.\n\n${ADMIN_COMMAND_USAGE}`);
        }
        environment = value;
        index += 1;
        break;
      }
      case "--ban": {
        if (action !== undefined) throw new Error("Choose exactly one action.\n\n" + ADMIN_COMMAND_USAGE);
        action = { kind: "ban", value: parseBoolean(argumentValue(args, index, option), option) };
        index += 1;
        break;
      }
      case "--can_add_resources": {
        if (action !== undefined) throw new Error("Choose exactly one action.\n\n" + ADMIN_COMMAND_USAGE);
        action = { kind: "can_add_resources", value: parseBoolean(argumentValue(args, index, option), option) };
        index += 1;
        break;
      }
      case "--role": {
        if (action !== undefined) throw new Error("Choose exactly one action.\n\n" + ADMIN_COMMAND_USAGE);
        const value = argumentValue(args, index, option);
        if (value !== "admin" && value !== "user") {
          throw new Error(`--role must be admin or user.\n\n${ADMIN_COMMAND_USAGE}`);
        }
        action = { kind: "role", value };
        index += 1;
        break;
      }
      case "--delete":
        if (action !== undefined) throw new Error("Choose exactly one action.\n\n" + ADMIN_COMMAND_USAGE);
        action = { kind: "delete" };
        break;
      case "--help":
        break;
    }
  }

  if (!username) throw new Error(`--user is required.\n\n${ADMIN_COMMAND_USAGE}`);
  if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) {
    throw new Error("--user must be 3–32 letters, numbers, or underscores.\n\n" + ADMIN_COMMAND_USAGE);
  }
  if (!environment) throw new Error(`--env is required.\n\n${ADMIN_COMMAND_USAGE}`);
  if (!action) throw new Error(`Choose one action.\n\n${ADMIN_COMMAND_USAGE}`);

  return { environment, username, action };
}

function getDatabaseUrl(environment: AdminEnvironment): string {
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

function databaseRole(role: RequestedRole): "student" | "admin" {
  return role === "admin" ? "admin" : "student";
}

async function findUser(client: Client, username: string): Promise<UserRow> {
  const result = await client.query<UserRow>(
    `
      SELECT user_id, username, email, role, is_banned, can_add_resources
      FROM "User"
      WHERE username = $1
      FOR UPDATE
    `,
    [username],
  );

  if (result.rows.length === 0) throw new Error(`No user found for username "${username}".`);
  if (result.rows.length > 1) throw new Error(`More than one user matched username "${username}".`);
  return result.rows[0];
}

async function updateUser(
  client: Client,
  options: AdminCommandOptions,
): Promise<UserRow> {
  await client.query("BEGIN");
  try {
    const user = await findUser(client, options.username);
    const { action } = options;

    if (action.kind === "delete") {
      throw new Error("Delete actions must use the delete transaction.");
    }

    if (action.kind === "ban") {
      await client.query(`UPDATE "User" SET is_banned = $1 WHERE user_id = $2`, [action.value, user.user_id]);
      user.is_banned = action.value;
    } else if (action.kind === "can_add_resources") {
      await client.query(`UPDATE "User" SET can_add_resources = $1 WHERE user_id = $2`, [action.value, user.user_id]);
      user.can_add_resources = action.value;
    } else {
      const role = databaseRole(action.value);
      await client.query(`UPDATE "User" SET role = $1 WHERE user_id = $2`, [role, user.user_id]);
      user.role = role;
    }

    await client.query("COMMIT");
    return user;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function deleteUser(client: Client, username: string): Promise<{ user: UserRow; resourceCount: number }> {
  await client.query("BEGIN");
  try {
    const user = await findUser(client, username);
    const resources = await client.query<ResourceRow>(
      `SELECT resource_id, resource_image_id FROM "Resource" WHERE owner_id = $1 FOR UPDATE`,
      [user.user_id],
    );
    const resourceIds = resources.rows.map((row) => row.resource_id);
    const imageIds = [
      ...resources.rows.map((row) => row.resource_image_id),
      ...(
        await client.query<{ profile_image_id: number | null }>(
          `SELECT profile_image_id FROM "User" WHERE user_id = $1`,
          [user.user_id],
        )
      ).rows.map((row) => row.profile_image_id),
    ].filter((imageId): imageId is number => imageId !== null);

    await client.query(
      `
        DELETE FROM "ReservationReview"
        WHERE reviewer_user_id = $1
           OR reviewee_user_id = $1
           OR reservation_id IN (
             SELECT reservation_id
             FROM "Reservation"
             WHERE user_id = $1 OR resource_id = ANY($2::integer[])
           )
      `,
      [user.user_id, resourceIds],
    );
    await client.query(`DELETE FROM "ResourceReview" WHERE reviewer_user_id = $1`, [user.user_id]);
    await client.query(`DELETE FROM "EmailVerificationToken" WHERE user_id = $1`, [user.user_id]);
    await client.query(`DELETE FROM "Session" WHERE user_id = $1`, [user.user_id]);
    await client.query(`DELETE FROM "Notification" WHERE user_id = $1`, [user.user_id]);
    await client.query(
      `DELETE FROM "Reservation" WHERE user_id = $1 OR resource_id = ANY($2::integer[])`,
      [user.user_id, resourceIds],
    );
    await client.query(`DELETE FROM "CreditTransaction" WHERE user_id = $1`, [user.user_id]);
    await client.query(`DELETE FROM "Resource" WHERE owner_id = $1`, [user.user_id]);
    await client.query(`DELETE FROM "ImageMetadata" WHERE image_id = ANY($1::integer[])`, [imageIds]);
    await client.query(`DELETE FROM "User" WHERE user_id = $1`, [user.user_id]);
    await client.query("COMMIT");

    return { user, resourceCount: resourceIds.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main(): Promise<void> {
  let options: AdminCommandOptions;

  try {
    options = parseAdminCommandArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === ADMIN_COMMAND_USAGE) {
      console.log(message);
      return;
    }
    throw error;
  }

  const client = new Client({ connectionString: getDatabaseUrl(options.environment) });
  await client.connect();

  try {
    if (options.action.kind === "delete") {
      const result = await deleteUser(client, options.username);
      console.log(
        `Permanently deleted ${result.user.username} (${result.user.email}) in ${options.environment}. ` +
        `Removed ${result.resourceCount} owned resource${result.resourceCount === 1 ? "" : "s"}. ` +
        "R2 image objects, if any, require separate cleanup.",
      );
      return;
    }

    const user = await updateUser(client, options);
    const action = options.action;
    const detail = action.kind === "role"
      ? `role=${action.value}`
      : `${action.kind}=${action.value}`;
    console.log(`Updated ${user.username} (${user.email}) in ${options.environment}: ${detail}.`);
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
