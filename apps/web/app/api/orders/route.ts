import { z } from "zod";
import { assertSameOrigin, handle, json, readBody } from "@/server/http";
import { createOrderForReading } from "@/server/orders";
import { requireUser } from "@/server/session";

export const POST = handle(async (req) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { readingId } = await readBody(req, z.object({ readingId: z.uuid() }));
  return json(await createOrderForReading(user, readingId));
});
