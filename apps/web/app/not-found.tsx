import Link from "next/link";
import { PageShell } from "@/components/site-chrome";

export default function NotFound() {
  return (
    <PageShell>
      <h1 className="font-serif text-2xl text-ink">没有找到这个页面</h1>
      <Link href="/" className="mt-4 inline-block rounded-full bg-qing px-5 py-2 text-paper">
        回到首页
      </Link>
    </PageShell>
  );
}
