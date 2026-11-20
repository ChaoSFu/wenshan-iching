import { assertSameOrigin, handle, json } from "@/server/http";
import { confirmOrder } from "@/server/orders";
import { requireUser } from "@/server/session";

export const POST = handle(async (req, ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  return json(await confirmOrder(user.id, id!));
});
