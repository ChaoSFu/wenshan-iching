import { assertSameOrigin, handle, json, readBody } from "@/server/http";
import { createOrderForReading, createOrderSchema } from "@/server/orders";
import { requireUser } from "@/server/session";

export const POST = handle(async (req) => {
  assertSameOrigin(req);
  const user = await requireUser();
  // 带上用户确认时看到的题意修订、分流结果与报价版本，服务端逐一核对
  return json(await createOrderForReading(user, await readBody(req, createOrderSchema)));
});
