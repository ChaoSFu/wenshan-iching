import { env } from "../env";
import { createFakeProvider } from "./fake";
import { createStripeProvider } from "./stripe";
import type { PaymentProvider } from "./types";

let provider: PaymentProvider | null = null;

export function getPaymentProvider(): PaymentProvider {
  provider ??= env().PAYMENT_PROVIDER === "stripe" ? createStripeProvider() : createFakeProvider();
  return provider;
}

export function __setPaymentProviderForTests(p: PaymentProvider | null): void {
  provider = p;
}

export * from "./types";
