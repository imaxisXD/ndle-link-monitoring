import { drizzle } from 'drizzle-orm/bun-sql';
import * as schema from './schema';

function createDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is not set');
  }
  return drizzle({
    connection: { url: connectionString },
    schema,
  });
}

export type Database = ReturnType<typeof createDatabase>;

let instance: Database | null = null;
let instanceUrl: string | undefined;

export function getDb(): Database {
  const currentUrl = process.env.DATABASE_URL;
  if (!instance || instanceUrl !== currentUrl) {
    instance = createDatabase();
    instanceUrl = currentUrl;
  }
  return instance;
}

export async function closeDatabase(): Promise<void> {
  if (!instance) return;
  const toClose = instance;
  instance = null;
  instanceUrl = undefined;
  await toClose.$client.close({ timeout: 5 });
}

export const db: Database = new Proxy({} as Database, {
  get(_target, prop, receiver) {
    const target = getDb();
    const value = Reflect.get(target, prop, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
