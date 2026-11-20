import { handle, json } from "@/server/http";
import { getOrderView } from "@/server/orders";
import { requireUser } from "@/server/session";

export const GET = handle(async (_req, ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  return json(await getOrderView(user.id, id!));
});
