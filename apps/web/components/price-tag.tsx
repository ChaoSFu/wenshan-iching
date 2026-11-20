"use client";

import { useOffer } from "@/lib/offer";

/** 价格只认服务端配置；静态页面里用它显示，不在构建时读取环境变量 */
export function PriceTag({ prefix = "", suffix = "" }: { prefix?: string; suffix?: string }) {
  const offer = useOffer();
  if (!offer) return null;
  return <>{`${prefix}${offer.salesEnabled ? offer.priceLabel : "暂未开放"}${suffix}`}</>;
}
