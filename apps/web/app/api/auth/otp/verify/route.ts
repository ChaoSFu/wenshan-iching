import { z } from "zod";
import { sessionCookie, verifyOtp } from "@/server/auth";
import { assertSameOrigin, handle, json, readBody } from "@/server/http";

export const POST = handle(async (req) => {
  assertSameOrigin(req);
  const { email, code } = await readBody(req, z.object({ email: z.string().max(254), code: z.string().max(10) }));
  const { token } = await verifyOtp(email, code.trim());
  const res = json({ ok: true });
  res.cookies.set(sessionCookie(token));
  return res;
});
