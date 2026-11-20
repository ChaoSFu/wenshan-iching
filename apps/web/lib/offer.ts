"use client";

import { useEffect, useState } from "react";

/** 报价与开放状态：只认服务端 /api/offer，不在前端写死 */
export interface ClientOffer {
  salesEnabled: boolean;
  priceLabel: string;
  amountMinor: number;
  currency: string;
  reviewRequired: boolean;
}

let cache: Promise<ClientOffer | null> | null = null;

export function fetchOffer(): Promise<ClientOffer | null> {
  cache ??= fetch("/api/offer", { credentials: "same-origin" })
    .then((r) => (r.ok ? (r.json() as Promise<ClientOffer>) : null))
    .catch(() => null);
  return cache;
}

/** undefined：加载中；null：获取失败（按"暂未开放"处理） */
export function useOffer(): ClientOffer | null | undefined {
  const [offer, setOffer] = useState<ClientOffer | null | undefined>(undefined);
  useEffect(() => {
    void fetchOffer().then(setOffer);
  }, []);
  return offer;
}
