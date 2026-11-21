import { z } from "zod";
import { assertSameOrigin, handle, json, readBody } from "@/server/http";
import { requeueGenerationByOps } from "@/server/orders";
import { currentUser } from "@/server/session";
import { requireOps } from "@/server/support";

export const POST = handle(async (req, ctx) => {
  assertSameOrigin(req);
  const ops = requireOps(await currentUser());
  const { id } = await ctx.params;
  const { note } = await readBody(req, z.object({ note: z.string().trim().min(2).max(200) }));
  await requeueGenerationByOps(id!, ops.email, note);
  return json({ ok: true });
});
