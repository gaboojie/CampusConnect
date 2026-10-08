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

function getDatabaseUrl(): string {
  const databaseUrlIndex = process.argv.indexOf("--database-url");
  const databaseUrlFromArgs =
    databaseUrlIndex >= 0 ? process.argv[databaseUrlIndex + 1] : undefined;
  const databaseUrl = databaseUrlFromArgs ?? process.env.DATABASE_URL;

  if (!databaseUrl || databaseUrl.startsWith("--")) {
    throw new Error(
      "Provide a database URL with --database-url or the DATABASE_URL environment variable.",
    );
  }

  return databaseUrl;
}

async function main(): Promise<void> {
  const environment = getMigrationEnvironment();
  const migrationsDirectory = join(projectRoot, "migrations", environment);
  const client = new Client({ connectionString: getDatabaseUrl() });
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
