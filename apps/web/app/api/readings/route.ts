import { assertSameOrigin, handle, json, readBody } from "@/server/http";
import { uploadReading, uploadReadingSchema } from "@/server/readings";
import { requireUser } from "@/server/session";

export const POST = handle(async (req) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const input = await readBody(req, uploadReadingSchema);
  return json(await uploadReading(user.id, input));
});
