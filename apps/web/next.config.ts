import path from "node:path";
import type { NextConfig } from "next";

// 仓库根目录（npm workspaces）。next 命令在 apps/web 下运行。
const repoRoot = path.resolve(process.cwd(), "../..");

const nextConfig: NextConfig = {
  transpilePackages: ["@wenshan/iching-core", "@wenshan/content"],
  poweredByHeader: false,
  // PGlite（WASM）与 postgres 驱动直接从 node_modules 加载，不打包
  serverExternalPackages: ["@electric-sql/pglite", "postgres"],
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
