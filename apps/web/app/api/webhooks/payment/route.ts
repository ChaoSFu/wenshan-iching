import { handle, json } from "@/server/http";
import { handlePaymentEvent } from "@/server/orders";
import { WebhookSignatureError, getPaymentProvider } from "@/server/payments";

/** 支付平台回调（Stripe 后台把 webhook 地址配置为 /api/webhooks/payment） */
export const POST = handle(async (req) => {
  const raw = await req.text();
  let event;
  try {
    event = getPaymentProvider().parseWebhook(raw, req.headers);
  } catch (err) {
    if (err instanceof WebhookSignatureError) return json({ error: "bad_signature" }, 400);
    throw err;
  }
  const result = await handlePaymentEvent(event);
  return json({ received: true, result });
});
