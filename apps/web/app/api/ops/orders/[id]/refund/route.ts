import { z } from "zod";
import { assertSameOrigin, handle, json, readBody } from "@/server/http";
import { requestRefundByOps } from "@/server/orders";
import { currentUser } from "@/server/session";
import { requireOps } from "@/server/support";

/** 运营核实投诉后发起原路退款（走现有退款任务与回调流程） */
export const POST = handle(async (req, ctx) => {
  assertSameOrigin(req);
  requireOps(await currentUser());
  const { id } = await ctx.params;
  const { reason } = await readBody(req, z.object({ reason: z.string().trim().min(2).max(200) }));
  await requestRefundByOps(id!, `ops:${reason}`);
  return json({ ok: true });
});
