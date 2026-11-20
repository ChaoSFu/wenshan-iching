import type { Metadata } from "next";
import { PageShell } from "@/components/site-chrome";
import { ReportView } from "./report-view";

export const metadata: Metadata = { title: "解读报告", robots: { index: false } };

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <PageShell>
      <ReportView reportId={id} />
    </PageShell>
  );
}
