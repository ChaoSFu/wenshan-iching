import type { Metadata } from "next";
import { Suspense } from "react";
import { PageShell } from "@/components/site-chrome";
import { AskForm } from "./ask-form";

export const metadata: Metadata = { title: "写下你的问题" };

export default function AskPage() {
  return (
    <PageShell>
      <Suspense fallback={<p className="text-sm text-muted">正在加载…</p>}>
        <AskForm />
      </Suspense>
    </PageShell>
  );
}
