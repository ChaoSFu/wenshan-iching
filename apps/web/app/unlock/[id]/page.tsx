import type { Metadata } from "next";
import { PageShell } from "@/components/site-chrome";
import { UnlockFlow } from "./unlock-flow";

export const metadata: Metadata = { title: "解锁报告", robots: { index: false } };

export default async function UnlockPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <PageShell>
      <UnlockFlow clientId={id} />
    </PageShell>
  );
}
