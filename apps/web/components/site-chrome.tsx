import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="border-b border-line/70 print:hidden">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
        <Link href="/" className="flex items-baseline gap-2 font-serif text-xl tracking-widest text-ink">
          <span aria-hidden className="inline-block h-3 w-3 translate-y-[-2px] rounded-full bg-zhu" />
          问山
        </Link>
        <nav className="flex items-center gap-5 text-sm text-ink-soft">
          <Link href="/samples" className="hover:text-qing">
            样例
          </Link>
          <Link href="/rules" className="hidden hover:text-qing sm:inline">
            规则
          </Link>
          <Link href="/me" className="hover:text-qing">
            我的报告
          </Link>
          <Link
            href="/ask"
            className="rounded-full bg-qing px-4 py-1.5 text-paper transition-colors hover:bg-qing-deep"
          >
            起卦
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-line/70 pb-[max(env(safe-area-inset-bottom),1.5rem)] print:hidden">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 pt-6 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
        <p>问山以《周易》原文为本，提供文化与自我反思的角度，不替代医疗、法律、投资等专业意见。</p>
        <nav className="flex gap-4">
          <Link href="/rules" className="hover:text-qing">
            起卦与选文规则
          </Link>
          <Link href="/help" className="hover:text-qing">
            求助指引
          </Link>
        </nav>
      </div>
    </footer>
  );
}

export function PageShell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return <main className={`mx-auto w-full px-4 pt-6 sm:pt-10 ${wide ? "max-w-5xl" : "max-w-2xl"}`}>{children}</main>;
}
