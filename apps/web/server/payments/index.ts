import { requireCapability } from "../capabilities";
import { env } from "../env";
import { createFakeProvider } from "./fake";
import { createStripeProvider } from "./stripe";
import type { PaymentProvider } from "./types";

let provider: PaymentProvider | null = null;

/** 生产环境没配 Stripe 时抛 CapabilityUnavailableError（503），绝不退回模拟支付 */
export function getPaymentProvider(): PaymentProvider {
  if (provider) return provider;
  requireCapability("payments");
  provider = env().PAYMENT_PROVIDER === "stripe" ? createStripeProvider() : createFakeProvider();
  return provider;
}

export function __setPaymentProviderForTests(p: PaymentProvider | null): void {
  provider = p;
}

export * from "./types";
