import { handle, json } from "@/server/http";
import { listOrders } from "@/server/orders";
import { requireUser } from "@/server/session";

export const GET = handle(async () => {
  const user = await requireUser();
  return json({ orders: await listOrders(user.id) });
});
