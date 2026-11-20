import Link from "next/link";
import type { HelpResources } from "@wenshan/content";

export function Notice({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warn";
  title: string;
  children: React.ReactNode;
}) {
  const styles = tone === "warn" ? "border-zhu/40 bg-zhu-soft/60" : "border-lu/50 bg-lu-soft/60";
  return (
    <div role="status" className={`rounded-xl border px-4 py-3 text-sm ${styles}`}>
      <p className="font-medium text-ink">{title}</p>
      <div className="mt-1 text-ink-soft">{children}</div>
    </div>
  );
}

/** 即时人身安全：暂停解读并给出求助指引（PRD §7「积极引导的验收标准」）。 */
export function CrisisPanel({ message, help }: { message: string; help: HelpResources }) {
  return (
    <section role="alert" className="rounded-2xl border border-zhu/50 bg-zhu-soft/70 p-5">
      <h2 className="font-serif text-lg text-ink">先确认你的安全</h2>
      <p className="mt-2 text-sm text-ink-soft">{message}</p>
      <ul className="mt-4 space-y-1.5 text-sm">
        {help.regions.slice(0, 3).map((r) => (
          <li key={r.id}>
            <span className="text-muted">{r.name}：</span>
            {r.items
              .filter((i) => i.number)
              .map((i) => `${i.label} ${i.number}`)
              .join("，")}
          </li>
        ))}
      </ul>
      <Link href="/help" className="mt-4 inline-block text-sm font-medium text-qing underline underline-offset-4">
        查看更多地区的求助方式
      </Link>
    </section>
  );
}
