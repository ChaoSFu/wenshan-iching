import path from "node:path";
import type { NextConfig } from "next";

// 仓库根目录（npm workspaces）。next 命令在 apps/web 下运行。
const repoRoot = path.resolve(process.cwd(), "../..");

const nextConfig: NextConfig = {
  transpilePackages: ["@wenshan/iching-core", "@wenshan/content"],
  poweredByHeader: false,
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
