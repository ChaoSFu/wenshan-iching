import { env } from "@/server/env";
import { handle, json } from "@/server/http";
import { releaseStatus } from "@/server/release";
import { currentUser } from "@/server/session";
import { requireOps } from "@/server/support";

/** 发布验收：当前运行配置下各能力是否就绪、内容严格审核与求助号码核实进度（只含配置名，不含值） */
export const GET = handle(async () => {
  requireOps(await currentUser());
  return json(releaseStatus(env()));
});
