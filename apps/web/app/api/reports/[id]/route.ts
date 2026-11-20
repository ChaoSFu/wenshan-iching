import { assertSameOrigin, handle, json } from "@/server/http";
import { deleteReport, getReportView } from "@/server/report/service";
import { requireUser } from "@/server/session";

export const GET = handle(async (_req, ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  return json(await getReportView(user.id, id!));
});

export const DELETE = handle(async (req, ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  await deleteReport(user.id, id!);
  return json({ ok: true });
});
