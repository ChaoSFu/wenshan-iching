import { assertSameOrigin, handle, json } from "@/server/http";
import { requireUser } from "@/server/session";
import { runTriage } from "@/server/triage";

export const POST = handle(async (req, ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  return json(await runTriage(user.id, id!));
});
