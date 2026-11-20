import { assertSameOrigin, clientIp, handle, json, readBody } from "@/server/http";
import { currentUser } from "@/server/session";
import { submitTicket, supportSubmitSchema } from "@/server/support";

/** 提交工单：游客也可以提交；订单、报告只在服务端确认归属后关联 */
export const POST = handle(async (req) => {
  assertSameOrigin(req);
  const input = await readBody(req, supportSubmitSchema);
  const user = await currentUser().catch(() => null);
  return json(await submitTicket(input, { user, ip: clientIp(req) }));
});
