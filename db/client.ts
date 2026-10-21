import { Client } from "pg";

export type DatabaseQueryResult<T = Record<string, unknown>> = {
  rows: T[];
  rowCount: number | null;
};

export type DatabaseClient = {
  connect(): Promise<void>;
  query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<DatabaseQueryResult<T>>;
  end(): Promise<void>;
};

export type DatabaseClientFactory = (connectionString: string) => DatabaseClient;

export const defaultDatabaseClientFactory: DatabaseClientFactory = (
  connectionString,
) => new Client({ connectionString }) as unknown as DatabaseClient;

export async function withDatabase<T>(
  connectionString: string,
  createClient: DatabaseClientFactory,
  callback: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  const client = createClient(connectionString);
  await client.connect();

  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}
