/**
 * 对 DATABASE_URL 指向的 PostgreSQL 执行迁移（生产部署前运行一次）：
 *   DATABASE_URL=postgres://... npm run db:migrate -w @wenshan/web
 * 开发环境的 PGlite 会在启动时自动迁移，不需要运行这个脚本。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const client = postgres(url, { max: 1 });
await migrate(drizzle(client), {
  migrationsFolder: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../server/db/migrations"),
});
await client.end();
console.log("migrations applied");
