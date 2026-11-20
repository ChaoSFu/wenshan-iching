import type { Metadata } from "next";
import { PageShell } from "@/components/site-chrome";
import { topicsBundle } from "@/lib/content";

export const metadata: Metadata = { title: "求助指引" };

export default function HelpPage() {
  const help = topicsBundle.help;
  return (
    <PageShell>
      <h1 className="font-serif text-2xl text-ink">求助指引</h1>
      <p className="mt-3 text-base leading-7 text-ink">{help.intro}</p>
      <div className="mt-6 space-y-3">
        {help.regions.map((r) => (
          <section key={r.id} className="rounded-2xl border border-line bg-card p-4">
            <h2 className="font-medium text-ink">{r.name}</h2>
            <ul className="mt-2 space-y-1 text-sm text-ink-soft">
              {r.items.map((i) => (
                <li key={i.label} className="flex justify-between gap-4">
                  <span>{i.label}</span>
                  {i.number && (
                    <a href={`tel:${i.number}`} className="font-medium tabular-nums text-qing">
                      {i.number}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="mt-4 text-xs text-muted">号码与服务时间以当地官方公布为准。</p>
    </PageShell>
  );
}
