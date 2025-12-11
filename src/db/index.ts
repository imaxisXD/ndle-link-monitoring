import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("[Monitoring Service ⏰] DATABASE_URL environment variable is not set");
}

export const db = drizzle({
  connection: { url: connectionString || "" },
  schema,
});
