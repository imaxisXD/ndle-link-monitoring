import { drizzle } from 'drizzle-orm/bun-sql';
import { migrate } from 'drizzle-orm/bun-sql/migrator';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_URL environment variable is not set');
  process.exit(1);
}

const db = drizzle({
  connection: { url: connectionString },
});

console.log('Running migrations...');

await migrate(db, { migrationsFolder: './drizzle' });

console.log('Migrations complete!');
