import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type MigrationEnvironment = "dev" | "prod";

function getMigrationEnvironment(): MigrationEnvironment {
  const environmentIndex = process.argv.indexOf("--environment");
  const environment =
    environmentIndex >= 0 ? process.argv[environmentIndex + 1] : undefined;

  if (environment === "dev" || environment === "prod") {
    return environment;
  }

  throw new Error(
    "Provide a migration environment with --environment dev or --environment prod.",
  );
}

function getDatabaseUrl(environment: MigrationEnvironment): string {
  const databaseUrlIndex = process.argv.indexOf("--database-url");
  const databaseUrlFromArgs =
    databaseUrlIndex >= 0 ? process.argv[databaseUrlIndex + 1] : undefined;
  const environmentVariable = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB";

  // Load the selected environment's local Hyperdrive connection string when
  // it has not already been exported or passed explicitly.
  const environmentFile = join(projectRoot, `.env.${environment}`);
  if (!databaseUrlFromArgs && !process.env[environmentVariable] && existsSync(environmentFile)) {
    process.loadEnvFile(environmentFile);
  }

  const databaseUrl = databaseUrlFromArgs ?? process.env[environmentVariable];

  if (!databaseUrl || databaseUrl.startsWith("--")) {
    throw new Error(
      `Set ${environmentVariable} or provide --database-url before running ${environment} migrations.`,
    );
  }

  return databaseUrl;
}

async function main(): Promise<void> {
  const environment = getMigrationEnvironment();
  const migrationsDirectory = join(projectRoot, "migrations", environment);
  const client = new Client({ connectionString: getDatabaseUrl(environment) });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const migrationFiles = (await readdir(migrationsDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    const applied = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations",
    );
    const appliedVersions = new Set(applied.rows.map((row) => row.version));

    for (const migrationFile of migrationFiles) {
      const version = basename(migrationFile, ".sql");

      if (appliedVersions.has(version)) {
        console.log(`Skipping ${migrationFile}`);
        continue;
      }

      const sql = await readFile(join(migrationsDirectory, migrationFile), "utf8");

      console.log(`Applying ${migrationFile}`);
      await client.query("BEGIN");

      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version) VALUES ($1)",
          [version],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    console.log(`${environment} migrations complete.`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
