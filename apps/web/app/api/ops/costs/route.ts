import { handle, json } from "@/server/http";
import { costSummary } from "@/server/llm/usage";
import { currentUser } from "@/server/session";
import { requireOps } from "@/server/support";

export const GET = handle(async (req) => {
  requireOps(await currentUser());
  const days = Math.min(365, Math.max(1, Number(new URL(req.url).searchParams.get("days") ?? 30)));
  const to = new Date();
  return json(await costSummary(new Date(to.getTime() - days * 24 * 3600_000), to));
});
