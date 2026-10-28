import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";

type RoleEnvironment = "dev" | "prod";
type RequestedRole = "user" | "admin";
type DatabaseRole = "student" | "admin";

export type RoleCommandOptions = {
  environment: RoleEnvironment;
  identifierType: "username" | "email";
  identifier: string;
  role: RequestedRole;
};

type UserRow = {
  user_id: number;
  username: string;
  email: string;
  role: string;
};

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const databaseEnvironmentVariable = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB";

export const ROLE_COMMAND_USAGE = `Usage:
  npm run role -- --username <username> --role <user|admin> --env <dev|prod>
  npm run role -- --email <email> --role <user|admin> --env <dev|prod>`;

function getArgumentValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.\n\n${ROLE_COMMAND_USAGE}`);
  }

  return value.trim();
}

export function parseRoleCommandArgs(args: readonly string[]): RoleCommandOptions {
  if (args.includes("--help") || args.includes("-h")) {
    throw new Error(ROLE_COMMAND_USAGE);
  }

  const username = getArgumentValue(args, "--username");
  const email = getArgumentValue(args, "--email");
  const role = getArgumentValue(args, "--role");
  const environment = getArgumentValue(args, "--env");

  if ((username === undefined) === (email === undefined)) {
    throw new Error(`Provide exactly one of --username or --email.\n\n${ROLE_COMMAND_USAGE}`);
  }
  if (!role || (role !== "user" && role !== "admin")) {
    throw new Error(`--role must be user or admin.\n\n${ROLE_COMMAND_USAGE}`);
  }
  if (!environment || (environment !== "dev" && environment !== "prod")) {
    throw new Error(`--env must be dev or prod.\n\n${ROLE_COMMAND_USAGE}`);
  }

  const identifier = username ?? email;
  if (!identifier) {
    throw new Error(`The username or email cannot be empty.\n\n${ROLE_COMMAND_USAGE}`);
  }

  return {
    environment,
    identifierType: username !== undefined ? "username" : "email",
    identifier,
    role,
  };
}

function getDatabaseUrl(environment: RoleEnvironment): string {
  const environmentFile = join(projectRoot, `.env.${environment}`);

  if (!existsSync(environmentFile)) {
    throw new Error(
      `Missing ${environmentFile}. Copy .env.${environment}.example to .env.${environment} and configure it before running this command.`,
    );
  }

  // Always load the selected file so --env determines the database. The
  // connection string is read only by this process and is never printed.
  delete process.env[databaseEnvironmentVariable];
  process.loadEnvFile(environmentFile);

  const databaseUrl = process.env[databaseEnvironmentVariable];
  if (!databaseUrl) {
    throw new Error(
      `${databaseEnvironmentVariable} is missing from .env.${environment}.`,
    );
  }

  return databaseUrl;
}

function databaseRole(role: RequestedRole): DatabaseRole {
  return role === "admin" ? "admin" : "student";
}

async function updateUserRole(
  client: Client,
  options: RoleCommandOptions,
): Promise<UserRow> {
  const matchColumn = options.identifierType === "username" ? "username" : "email";
  const matchExpression =
    options.identifierType === "username" ? `u.${matchColumn} = $1` : `LOWER(u.${matchColumn}) = LOWER($1)`;

  await client.query("BEGIN");

  try {
    const userResult = await client.query<UserRow>(
      `
        SELECT u.user_id, u.username, u.email, u.role
        FROM "User" AS u
        WHERE ${matchExpression}
        FOR UPDATE
      `,
      [options.identifier],
    );

    if (userResult.rows.length === 0) {
      throw new Error(`No user found for ${options.identifierType} "${options.identifier}".`);
    }
    if (userResult.rows.length > 1) {
      throw new Error(`More than one user matched ${options.identifierType} "${options.identifier}".`);
    }

    const user = userResult.rows[0];
    const nextRole = databaseRole(options.role);

    await client.query(
      `UPDATE "User" SET role = $1 WHERE user_id = $2`,
      [nextRole, user.user_id],
    );
    await client.query("COMMIT");

    return { ...user, role: nextRole };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main(): Promise<void> {
  let options: RoleCommandOptions;

  try {
    options = parseRoleCommandArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === ROLE_COMMAND_USAGE) {
      console.log(message);
      return;
    }
    throw error;
  }

  const client = new Client({ connectionString: getDatabaseUrl(options.environment) });
  await client.connect();

  try {
    const user = await updateUserRole(client, options);
    console.log(
      `Updated ${user.username} (${user.email}) in ${options.environment}: ${user.role === "student" ? "user" : user.role}.`,
    );
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
