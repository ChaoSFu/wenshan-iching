import type { Metadata } from "next";
import { Suspense } from "react";
import { PageShell } from "@/components/site-chrome";
import { OrderStatus } from "./order-status";

export const metadata: Metadata = { title: "订单", robots: { index: false } };

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <PageShell>
      <Suspense fallback={<p className="text-sm text-muted">正在查询订单…</p>}>
        <OrderStatus orderId={id} />
      </Suspense>
    </PageShell>
  );
}
