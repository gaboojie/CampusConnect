import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

type DatabaseEnvironment = "dev" | "prod";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const resetPublicTablesSql = `
DO $$
DECLARE
    table_record record;
BEGIN
    FOR table_record IN
        SELECT schemaname, tablename
        FROM pg_tables
        WHERE schemaname = 'public'
    LOOP
        EXECUTE format(
            'DROP TABLE IF EXISTS %I.%I CASCADE',
            table_record.schemaname,
            table_record.tablename
        );
    END LOOP;
END
$$;
`;

function getArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;

  return value && !value.startsWith("--") ? value : undefined;
}

function getEnvironment(): DatabaseEnvironment {
  const environment = getArgument("--environment");

  if (environment === "dev" || environment === "prod") {
    return environment;
  }

  throw new Error(
    "Provide a target database with --environment dev or --environment prod.",
  );
}

function getDatabaseUrl(environment: DatabaseEnvironment): string {
  const databaseUrl = getArgument("--database-url");
  const environmentVariable = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB";

  // Load the selected environment's local Hyperdrive connection string when
  // it has not already been exported or passed explicitly.
  const environmentFile = join(projectRoot, `.env.${environment}`);
  if (!databaseUrl && !process.env[environmentVariable] && existsSync(environmentFile)) {
    process.loadEnvFile(environmentFile);
  }

  const configuredUrl = databaseUrl ?? process.env[environmentVariable];

  if (!configuredUrl) {
    throw new Error(
      `Set ${environmentVariable} or provide --database-url before resetting the ${environment} database.`,
    );
  }

  return configuredUrl;
}

async function confirmReset(environment: DatabaseEnvironment): Promise<boolean> {
  const confirmationText = `RESET ${environment.toUpperCase()}`;
  const readline = createInterface({ input, output });

  try {
    console.error(`WARNING: this will drop every table in the public schema of the ${environment} database.`);
    console.error("All application data and schema_migrations will be removed.");
    console.error("R2 buckets and their images will not be modified.");
    const answer = await readline.question(
      `Type ${confirmationText} to continue: `,
    );

    return answer.trim() === confirmationText;
  } finally {
    readline.close();
  }
}

async function main(): Promise<void> {
  const environment = getEnvironment();
  const databaseUrl = getDatabaseUrl(environment);

  if (!(await confirmReset(environment))) {
    console.log("Database reset cancelled.");
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query("BEGIN");

    try {
      await client.query(resetPublicTablesSql);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    console.log(`${environment} database reset complete.`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
