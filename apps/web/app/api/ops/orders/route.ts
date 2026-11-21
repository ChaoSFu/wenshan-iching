import { handle, json } from "@/server/http";
import { listOrderExceptions } from "@/server/ops";
import { currentUser } from "@/server/session";
import { requireOps } from "@/server/support";

/** 订单异常列表：待核实、退款失败、长时间未完成的退款、生成异常、部分退款 */
export const GET = handle(async (req) => {
  requireOps(await currentUser());
  return json({ orders: await listOrderExceptions(new URL(req.url).searchParams.get("q") ?? undefined) });
});
