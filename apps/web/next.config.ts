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
  // 只影响开发服务器：允许用 127.0.0.1 打开（与 localhost 的 cookie、会话存储互不干扰，便于并行验收）
  allowedDevOrigins: ["127.0.0.1"],
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
