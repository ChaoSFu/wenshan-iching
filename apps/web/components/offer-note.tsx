"use client";

import { useOffer } from "@/lib/offer";

/** 首页的付费说明：价格与是否开放都来自服务端 */
export function OfferNote() {
  const offer = useOffer();
  const tail =
    offer === undefined ? "" : offer?.salesEnabled ? `，一次付款 ${offer.priceLabel}。` : "（付费报告暂未开放）。";
  return (
    <p className="mt-4 text-sm text-muted">
      免费：起卦、原文与白话简读。付费：结合你的处境给出待核实的信息和七天内可以尝试的行动{tail}
    </p>
  );
}
