import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { env } from "../env";
import * as schema from "./schema";

export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

export function migrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  // 只在开发（PGlite）和测试时用到；生产用 npm run db:migrate，不需要把迁移文件打进服务端产物
  const fromRepoRoot = path.resolve(/*turbopackIgnore: true*/ process.cwd(), "apps/web/server/db/migrations");
  return existsSync(fromRepoRoot) ? fromRepoRoot : path.resolve(/*turbopackIgnore: true*/ process.cwd(), "server/db/migrations");
}

/** 内存中的 PGlite 实例（测试与 PGLITE_DIR=memory 时使用），已执行迁移 */
export async function createMemoryDb(): Promise<DB> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: migrationsDir() });
  return db as unknown as DB;
}

async function connect(): Promise<DB> {
  const e = env();
  if (e.DATABASE_URL) {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    return drizzle(postgres(e.DATABASE_URL, { max: 10 }), { schema }) as unknown as DB;
  }
  if (e.PGLITE_DIR === "memory") return createMemoryDb();

  // 开发环境：嵌入式 PGlite，数据存在 apps/web/.data/pglite，启动时自动迁移
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const dir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), e.PGLITE_DIR);
  mkdirSync(dir, { recursive: true });
  const db = drizzle(new PGlite(dir), { schema });
  await migrate(db, { migrationsFolder: migrationsDir() });
  return db as unknown as DB;
}

// 挂在 globalThis 上，开发时热更新不会重复打开数据库
const g = globalThis as unknown as { __wenshanDb?: Promise<DB> };

export function getDb(): Promise<DB> {
  g.__wenshanDb ??= connect();
  return g.__wenshanDb;
}

export function __setDbForTests(db: DB): void {
  g.__wenshanDb = Promise.resolve(db);
}

export { schema };
