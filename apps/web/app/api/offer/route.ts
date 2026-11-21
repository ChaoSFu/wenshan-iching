import { handle, json } from "@/server/http";
import { getOffer } from "@/server/offer";

/** 报价与开放状态（首页、结果页、解锁页共用） */
export const GET = handle(async () => {
  const o = getOffer();
  return json({ salesEnabled: o.salesEnabled, priceLabel: o.priceLabel, priceVersion: o.priceVersion, amountMinor: o.amountMinor, currency: o.currency, reviewRequired: o.reviewRequired });
});
