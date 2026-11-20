import { z } from "zod";
import { requestOtp } from "@/server/auth";
import { assertSameOrigin, clientIp, handle, json, readBody } from "@/server/http";

export const POST = handle(async (req) => {
  assertSameOrigin(req);
  const { email } = await readBody(req, z.object({ email: z.string().max(254) }));
  await requestOtp(email, clientIp(req));
  // 不论邮箱是否注册过，回应都一样
  return json({ ok: true });
});
