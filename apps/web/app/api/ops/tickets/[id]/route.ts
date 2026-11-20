import { z } from "zod";
import { TICKET_STATUSES } from "@/server/db/schema";
import { assertSameOrigin, handle, json, readBody } from "@/server/http";
import { currentUser } from "@/server/session";
import { requireOps, updateTicketStatus } from "@/server/support";

export const PATCH = handle(async (req, ctx) => {
  assertSameOrigin(req);
  requireOps(await currentUser());
  const { id } = await ctx.params;
  const { status } = await readBody(req, z.object({ status: z.enum(TICKET_STATUSES) }));
  await updateTicketStatus(id!, status);
  return json({ ok: true });
});
