import { z } from "zod";
import { assertSameOrigin, handle, json, readBody } from "@/server/http";
import { retryRefundByOps } from "@/server/refunds";
import { currentUser } from "@/server/session";
import { requireOps } from "@/server/support";

/** 退款失败后，先向支付方核对上一笔结果，确实失败才开新尝试 */
export const POST = handle(async (req, ctx) => {
  assertSameOrigin(req);
  const ops = requireOps(await currentUser());
  const { id } = await ctx.params;
  const { note } = await readBody(req, z.object({ note: z.string().trim().min(2).max(200) }));
  return json({ message: await retryRefundByOps(id!, ops.email, note) });
});
