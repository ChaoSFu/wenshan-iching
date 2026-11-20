import { cookies } from "next/headers";
import { SESSION_COOKIE, userFromToken, type SessionUser } from "./auth";
import { HttpError } from "./http";

/** 在路由处理函数与服务端组件里取当前用户 */
export async function currentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  return userFromToken(store.get(SESSION_COOKIE)?.value);
}

export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new HttpError(401, "unauthorized", "请先登录");
  return user;
}
