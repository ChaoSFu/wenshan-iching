import { z } from "zod";
import { TOPIC_IDS, type TopicId } from "@wenshan/content";
import { assertSameOrigin, handle, json, readBody } from "@/server/http";
import { changeTopic } from "@/server/readings";
import { requireUser } from "@/server/session";

export const PATCH = handle(async (req, ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  const { topicId } = await readBody(req, z.object({ topicId: z.enum(TOPIC_IDS as [TopicId, ...TopicId[]]) }));
  await changeTopic(user.id, id!, topicId);
  return json({ ok: true });
});
