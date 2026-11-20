import { cookies } from "next/headers";
import { SESSION_COOKIE, deleteSession } from "@/server/auth";
import { assertSameOrigin, handle, json } from "@/server/http";

export const POST = handle(async (req) => {
  assertSameOrigin(req);
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await deleteSession(token);
  const res = json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
});
