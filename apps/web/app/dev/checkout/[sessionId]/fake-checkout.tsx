"use client";

import { useState } from "react";
import { api } from "@/lib/api";

export function FakeCheckout({ sessionId, amount }: { sessionId: string; amount: string }) {
  const [busy, setBusy] = useState(false);
  async function act(action: "pay" | "cancel" | "expire") {
    setBusy(true);
    const { redirect } = await api<{ redirect: string }>(`/api/dev/fake-checkout/${sessionId}`, { body: { action } });
    window.location.assign(redirect);
  }
  return (
    <div className="mt-6 flex flex-wrap gap-3">
      <button type="button" disabled={busy} onClick={() => void act("pay")} className="rounded-full bg-qing px-5 py-2.5 text-paper disabled:opacity-60">
        模拟支付成功 {amount}
      </button>
      <button type="button" disabled={busy} onClick={() => void act("cancel")} className="rounded-full border border-line px-5 py-2.5 text-ink-soft">
        取消，返回
      </button>
      <button type="button" disabled={busy} onClick={() => void act("expire")} className="rounded-full px-5 py-2.5 text-muted">
        模拟超时
      </button>
    </div>
  );
}
