import { handle, json } from "@/server/http";
import { currentUser } from "@/server/session";

export const GET = handle(async () => {
  const user = await currentUser();
  return json({ user: user ? { email: user.email } : null });
});
