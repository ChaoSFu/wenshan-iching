import { z } from "zod";
import { assertSameOrigin, handle, json, readBody } from "@/server/http";
import { adoptReframe } from "@/server/readings";
import { requireUser } from "@/server/session";

/** 用户确认采用改写后的问法：修订号 +1，之后需要重新分流 */
export const POST = handle(async (req, ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const { question } = await readBody(req, z.object({ question: z.string().max(200) }));
  return json(await adoptReframe(user.id, id!, question));
});
