import type { Metadata } from "next";
import { PageShell } from "@/components/site-chrome";
import { ResultView } from "./result-view";

export const metadata: Metadata = { title: "卦象与原文", robots: { index: false } };

export default async function ResultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <PageShell>
      <ResultView id={id} />
    </PageShell>
  );
}
