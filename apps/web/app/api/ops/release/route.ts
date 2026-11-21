import evidence from "@/acceptance/live-evidence.json";
import type { EvidenceFile } from "@/server/acceptance";
import { env } from "@/server/env";
import { handle, json } from "@/server/http";
import { releaseStatus } from "@/server/release";
import { currentUser } from "@/server/session";
import { requireOps } from "@/server/support";

/**
 * 发布验收：当前运行配置的三项结果（配置校验、内容审校、真实联调）。只含配置名，不含值。
 * 内容源文件的一致性与严格审校只能由 npm run release:check 读取源文件得出，这里标为"需要运行 CLI"。
 */
export const GET = handle(async () => {
  requireOps(await currentUser());
  return json(releaseStatus(env(), { evidence: (evidence as EvidenceFile).entries }));
});
