import { z } from "zod";
import { assertSameOrigin, handle, json, readBody } from "@/server/http";
import { submitFollowup } from "@/server/report/service";
import { requireUser } from "@/server/session";

export const POST = handle(async (req, ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const { question, idempotencyKey } = await readBody(
    req,
    z.object({ question: z.string().trim().min(2).max(200), idempotencyKey: z.string().min(8).max(64) }),
  );
  return json(await submitFollowup(user.id, id!, question, idempotencyKey));
});
