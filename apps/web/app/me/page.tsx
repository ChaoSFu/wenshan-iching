import type { Metadata } from "next";
import { PageShell } from "@/components/site-chrome";
import { MyReports } from "./my-reports";

export const metadata: Metadata = { title: "我的报告", robots: { index: false } };

export default function MePage() {
  return (
    <PageShell>
      <MyReports />
    </PageShell>
  );
}
