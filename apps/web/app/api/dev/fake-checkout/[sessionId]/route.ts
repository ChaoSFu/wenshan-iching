import { z } from "zod";
import { env } from "@/server/env";
import { HttpError, assertSameOrigin, handle, json, readBody } from "@/server/http";
import { handlePaymentEvent } from "@/server/orders";
import { getPaymentProvider } from "@/server/payments";
import { completeFakeCheckout, expireFakeCheckout, getFakeSession } from "@/server/payments/fake";

/** 仅开发环境：模拟用户在结账页付款或取消 */
export const POST = handle(async (req, ctx) => {
  if (env().NODE_ENV === "production" || env().PAYMENT_PROVIDER !== "fake") throw new HttpError(404, "not_found");
  assertSameOrigin(req);
  const { sessionId } = await ctx.params;
  const session = getFakeSession(sessionId!);
  if (!session) throw new HttpError(404, "not_found");
  const { action } = await readBody(req, z.object({ action: z.enum(["pay", "cancel", "expire"]) }));
  if (action === "cancel") return json({ redirect: session.cancelUrl });
  const { body, signature } = action === "pay" ? completeFakeCheckout(sessionId!) : expireFakeCheckout(sessionId!);
  await handlePaymentEvent(getPaymentProvider().parseWebhook(body, new Headers({ "x-fake-signature": signature })));
  return json({ redirect: action === "pay" ? session.successUrl : session.cancelUrl });
});
