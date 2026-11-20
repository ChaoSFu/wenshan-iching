import { defineConfig } from "drizzle-kit";

// 由 server/db/schema.ts 生成 SQL 迁移：npm run db:generate -w @wenshan/web
export default defineConfig({
  dialect: "postgresql",
  schema: "./server/db/schema.ts",
  out: "./server/db/migrations",
});
