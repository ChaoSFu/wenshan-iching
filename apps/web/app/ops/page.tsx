import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/site-chrome";
import { currentUser } from "@/server/session";
import { isOps } from "@/server/support";
import { OpsConsole } from "./ops-console";

// 不在标题里写"运营后台"：非运营用户看到的 404 不应透露这个页面存在
export const metadata: Metadata = { robots: { index: false } };
export const dynamic = "force-dynamic";

/** 工单与成本后台：只对 OPS_EMAILS 里的登录用户开放，其他人看到 404 */
export default async function OpsPage({ searchParams }: { searchParams: Promise<{ ticket?: string }> }) {
  const user = await currentUser();
  if (!isOps(user)) notFound();
  const { ticket } = await searchParams;
  return (
    <PageShell wide>
      <OpsConsole initialQuery={ticket ?? ""} />
    </PageShell>
  );
}
