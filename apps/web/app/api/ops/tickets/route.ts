import { handle, json } from "@/server/http";
import { currentUser } from "@/server/session";
import { listTickets, requireOps } from "@/server/support";

export const GET = handle(async (req) => {
  requireOps(await currentUser());
  const url = new URL(req.url);
  return json({
    tickets: await listTickets({
      q: url.searchParams.get("q") ?? undefined,
      category: url.searchParams.get("category") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
    }),
  });
});
