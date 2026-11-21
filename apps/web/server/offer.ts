import { contentGate, type PendingItem, type TopicId } from "@wenshan/content";
import type { Cast } from "@wenshan/iching-core";
import { corpus, topicsBundle } from "./content";
import { env } from "./env";
import { HttpError } from "./http";

/**
 * 报价与开放状态的唯一来源：首页、结果页、解锁页和下单接口都读这里。
 * - SALES_ENABLED 默认关闭；
 * - 真实收款（Stripe）前，本次必需的原文、白话和主题必须已审核；
 * - 只有本地模拟支付（fake）可以通过 ALLOW_UNREVIEWED_CONTENT 放宽审核，用于测试配置。
 */

export interface Offer {
  salesEnabled: boolean;
  amountMinor: number;
  currency: string;
  priceLabel: string;
  /** 报价标识（绑定金额与币种），下单时页面原样带回 */
  priceVersion: string;
  provider: "stripe" | "fake";
  /** 是否要求内容已审核（真实收款时一定为 true） */
  reviewRequired: boolean;
}

export function formatPrice(amountMinor: number, currency: string): string {
  const v = (amountMinor / 100).toFixed(2);
  return currency.toLowerCase() === "usd" ? `US$${v}` : `${v} ${currency.toUpperCase()}`;
}

/**
 * 服务端报价标识：配置的报价版本 + 实际金额 + 币种。改价时即使忘了改 PRICE_VERSION，
 * 标识也会变，旧页面带着旧标识下单会被要求确认新价格（第三轮 P0）。
 */
export function quoteId(priceVersion: string, amountMinor: number, currency: string): string {
  return `${priceVersion}:${amountMinor}:${currency.toLowerCase()}`;
}

export function getOffer(): Offer {
  const e = env();
  return {
    salesEnabled: e.SALES_ENABLED,
    amountMinor: e.PRICE_AMOUNT_MINOR,
    currency: e.PRICE_CURRENCY,
    priceLabel: formatPrice(e.PRICE_AMOUNT_MINOR, e.PRICE_CURRENCY),
    priceVersion: quoteId(e.PRICE_VERSION, e.PRICE_AMOUNT_MINOR, e.PRICE_CURRENCY),
    provider: e.PAYMENT_PROVIDER,
    reviewRequired: !(e.PAYMENT_PROVIDER === "fake" && e.ALLOW_UNREVIEWED_CONTENT),
  };
}

export function assertSalesOpen(): Offer {
  const offer = getOffer();
  if (!offer.salesEnabled) throw new HttpError(403, "sales_closed", "付费报告暂未开放");
  return offer;
}

export function pendingContent(cast: Pick<Cast, "primary" | "changed" | "movingLines">, topicId: TopicId): PendingItem[] {
  return contentGate(cast, topicId, corpus, topicsBundle).pending;
}

/** 创建 Checkout 前的内容审核门槛 */
export function assertContentApproved(cast: Pick<Cast, "primary" | "changed" | "movingLines">, topicId: TopicId): void {
  if (!getOffer().reviewRequired) return;
  const pending = pendingContent(cast, topicId);
  if (pending.length) {
    throw new HttpError(409, "content_pending", "这一卦的原文或注释仍在审校，暂时不能购买报告", { pending });
  }
}
