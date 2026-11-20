import type { Metadata } from "next";
import { PageShell } from "@/components/site-chrome";
import { CastView } from "./cast-view";

export const metadata: Metadata = { title: "三币起卦", robots: { index: false } };

export default async function CastPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <PageShell>
      <CastView id={id} />
    </PageShell>
  );
}
