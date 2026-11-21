"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type Level = "pass" | "warn" | "fail";
interface Status {
  environment: string;
  salesEnabled: boolean;
  freeReady: boolean;
  salesReady: boolean;
  checks: { id: string; label: string; detail: string; free: Level; sales: Level }[];
  review: { helpUnverified: string[] };
}

const MARK: Record<Level, { text: string; cls: string }> = {
  pass: { text: "通过", cls: "text-qing" },
  warn: { text: "注意", cls: "text-muted" },
  fail: { text: "阻断", cls: "text-zhu font-medium" },
};

/** 发布验收：严格审核没通过时在这里明确显示"开放收款：不可发布"及原因 */
export function ReleasePanel() {
  const [s, setS] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void api<Status>("/api/ops/release").then(setS).catch(() => setS(null));
  }, []);
  if (!s) return null;
  return (
    <section>
      <h2 className="font-serif text-xl text-ink">发布验收</h2>
      <p className="mt-1 text-sm text-ink-soft">
        免费体验：<span className={s.freeReady ? "text-qing" : "text-zhu"}>{s.freeReady ? "可发布" : "不可发布"}</span>
        <span className="mx-2 text-line">|</span>
        开放收款：<span className={s.salesReady ? "text-qing" : "text-zhu"}>{s.salesReady ? "可发布" : "不可发布"}</span>
        <span className="ml-2 text-xs text-muted">
          （当前 {s.environment}，收款{s.salesEnabled ? "已开放" : "关闭"}
          {s.environment !== "production" ? "；开发环境使用替身服务，配置项按开发规则评估，上线前请运行 npm run release:check" : ""}）
        </span>
      </p>
      <button type="button" onClick={() => setOpen(!open)} className="mt-2 text-xs text-qing underline underline-offset-4">
        {open ? "收起明细" : "查看明细"}
      </button>
      {open && (
        <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[36rem] text-left text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th className="py-1 font-normal">检查项</th>
              <th className="py-1 font-normal">免费体验</th>
              <th className="py-1 font-normal">开放收款</th>
              <th className="py-1 font-normal">说明</th>
            </tr>
          </thead>
          <tbody>
            {s.checks.map((c) => (
              <tr key={c.id} className="border-t border-line align-top">
                <td className="py-1.5 pr-3 text-ink">{c.label}</td>
                <td className={`py-1.5 pr-3 ${MARK[c.free].cls}`}>{MARK[c.free].text}</td>
                <td className={`py-1.5 pr-3 ${MARK[c.sales].cls}`}>{MARK[c.sales].text}</td>
                <td className="py-1.5 text-ink-soft">{c.detail}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {open && s.review.helpUnverified.length > 0 && (
        <p className="mt-2 text-xs text-muted">未核实的求助号码：{s.review.helpUnverified.join("；")}</p>
      )}
    </section>
  );
}
