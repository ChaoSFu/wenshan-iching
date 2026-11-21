/**
 * 一键本地验收（第三轮 P1）：把替身验证与真实 PostgreSQL 并发测试接到同一套可重复执行的检查里。
 *
 *   npm run verify                  # 类型检查 → 内容一致性 → 测试（替身 + 真实 PostgreSQL 并发）→ 生产构建 → 替身评测
 *   npm run verify -- --skip-build  # 跳过生产构建
 *   npm run verify -- --skip-eval   # 跳过替身评测
 *
 * PostgreSQL：设置了 TEST_POSTGRES_URL 就用它（测试会在上面创建并删除自己的临时库）；
 * 没设置时，若本机有 initdb/pg_ctl，就在临时目录起一个只监听 127.0.0.1 的集群，跑完停掉并删除目录。
 * 两者都没有时这一项记为"环境缺失"，整体判为不通过（不会被当作通过）。
 *
 * 最后的汇总把失败分成"环境问题"（缺工具、端口、集群起不来）与"业务失败"（类型、测试、构建、内容不一致）。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

type Kind = "pass" | "business_fail" | "env_fail" | "skipped";
interface Step {
  name: string;
  kind: Kind;
  ms: number;
  detail: string;
}
const steps: Step[] = [];
const args = new Set(process.argv.slice(2));
const ROOT = path.resolve(import.meta.dirname, "..");

function run(name: string, cmd: string, argv: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  const t0 = Date.now();
  console.log(`\n▶ ${name}: ${cmd} ${argv.join(" ")}`);
  const r = spawnSync(cmd, argv, { cwd: ROOT, env, stdio: "inherit" });
  const ok = r.status === 0;
  steps.push({ name, kind: ok ? "pass" : "business_fail", ms: Date.now() - t0, detail: ok ? "" : `exit ${r.status ?? r.signal}` });
  return ok;
}

function which(bin: string): string | null {
  try {
    return execFileSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** 临时 PostgreSQL 集群：返回连接串与清理函数；起不来时返回原因 */
async function tempCluster(): Promise<{ url: string; stop: () => void } | { error: string }> {
  const initdb = which("initdb");
  const pgctl = which("pg_ctl");
  if (!initdb || !pgctl) return { error: "本机没有 initdb/pg_ctl，也没有设置 TEST_POSTGRES_URL" };
  const dir = mkdtempSync(path.join(tmpdir(), "wenshan-pg-"));
  const data = path.join(dir, "data");
  // macOS 上 postgres 要求 C 语言环境（否则 "postmaster became multithreaded"）；不用 Unix 套接字（路径长度限制），只走本机 TCP
  const env = { ...process.env, LC_ALL: "C", LANG: "C" };
  const port = await freePort();
  try {
    execFileSync(initdb, ["-D", data, "-U", "wenshan", "--auth=trust", "-E", "UTF8", "--locale=C"], { env, stdio: "ignore" });
    execFileSync(pgctl, ["-D", data, "-l", path.join(dir, "log"), "-w", "-o", `-c listen_addresses=127.0.0.1 -c port=${port} -c unix_socket_directories=''`, "start"], {
      env,
      stdio: "ignore",
    });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    return { error: `临时集群启动失败：${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  }
  return {
    url: `postgres://wenshan@127.0.0.1:${port}/postgres`,
    stop: () => {
      try {
        execFileSync(pgctl, ["-D", data, "-m", "fast", "-w", "stop"], { env, stdio: "ignore" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

run("类型检查", "npm", ["run", "typecheck"]);
run("内容一致性（源文件与 generated/）", "npm", ["run", "content:check"]);

let pgUrl = process.env.TEST_POSTGRES_URL ?? "";
let stopCluster: (() => void) | null = null;
if (!pgUrl) {
  const c = await tempCluster();
  if ("error" in c) {
    steps.push({ name: "临时 PostgreSQL", kind: "env_fail", ms: 0, detail: c.error });
  } else {
    pgUrl = c.url;
    stopCluster = c.stop;
    steps.push({ name: "临时 PostgreSQL", kind: "pass", ms: 0, detail: pgUrl });
  }
}
try {
  // 一次跑完全部测试：替身集成测试 + 真实 PostgreSQL 并发测试（有连接串时不会被跳过）
  const env = { ...process.env, ...(pgUrl ? { TEST_POSTGRES_URL: pgUrl } : {}) };
  run(pgUrl ? "测试（替身 + 真实 PostgreSQL 并发）" : "测试（仅替身；PostgreSQL 并发测试被跳过）", "npx", ["vitest", "run"], env);
} finally {
  stopCluster?.();
}

if (args.has("--skip-build")) steps.push({ name: "生产构建", kind: "skipped", ms: 0, detail: "--skip-build" });
else run("生产构建", "npm", ["run", "build"]);

if (args.has("--skip-eval")) steps.push({ name: "替身评测", kind: "skipped", ms: 0, detail: "--skip-eval" });
else run("替身评测（不调用真实模型）", "npm", ["run", "eval:models", "-w", "@wenshan/web"]);

// 发布验收只作参考：本机没有生产配置时判"不可发布"是预期结果，不计入本次验收
console.log("\n▶ 发布验收（参考，不计入结果）");
spawnSync("npm", ["run", "release:check", "--silent"], { cwd: ROOT, stdio: "inherit" });

const mark: Record<Kind, string> = { pass: "通过", business_fail: "业务失败", env_fail: "环境问题", skipped: "跳过" };
console.log("\n本地验收汇总");
for (const s of steps) console.log(`  ${mark[s.kind].padEnd(4, "　")}  ${s.name}${s.ms ? `（${(s.ms / 1000).toFixed(1)}s）` : ""}${s.detail ? ` · ${s.detail}` : ""}`);
const business = steps.filter((s) => s.kind === "business_fail");
const envFail = steps.filter((s) => s.kind === "env_fail");
console.log(`\n结论：${business.length || envFail.length ? "不通过" : "通过"}（业务失败 ${business.length} 项，环境问题 ${envFail.length} 项）`);
process.exit(business.length || envFail.length ? 1 : 0);
