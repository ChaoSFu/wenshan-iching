import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // apps/web 的代码用 "@/..." 引用自身目录
  resolve: { alias: { "@": path.join(root, "apps/web") } },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/web/test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
