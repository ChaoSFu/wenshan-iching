"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";

/**
 * 邮箱验证码登录。整个过程不离开当前标签页，免费结果（只存在 sessionStorage）不会丢。
 */
export function LoginForm({ onDone, intro }: { onDone: () => void; intro?: string }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(t);
  }, [cooldown]);

  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setError("请输入有效的邮箱地址");
      return;
    }
    setBusy(true);
    try {
      await api("/api/auth/otp/request", { body: { email: email.trim() } });
      setStep("code");
      setCooldown(60);
      window.setTimeout(() => codeRef.current?.focus(), 50);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "发送失败，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/auth/otp/verify", { body: { email: email.trim(), code: code.trim() } });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "验证失败，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-line bg-card p-5">
      <h2 className="font-serif text-lg text-ink">用邮箱登录</h2>
      <p className="mt-1 text-sm text-ink-soft">{intro ?? "登录后可以购买报告，并在任何设备上回看。"}</p>
      {step === "email" ? (
        <form onSubmit={sendCode} className="mt-4 space-y-3" noValidate>
          <label htmlFor="login-email" className="text-sm text-ink-soft">
            邮箱
          </label>
          <input
            id="login-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-xl border border-line bg-paper/60 px-3 py-2.5 text-base focus:border-qing focus:outline-none"
            placeholder="you@example.com"
          />
          {error && <p className="text-sm text-zhu">{error}</p>}
          <button type="submit" disabled={busy} className="rounded-full bg-qing px-5 py-2.5 text-paper disabled:opacity-60">
            {busy ? "正在发送…" : "发送验证码"}
          </button>
        </form>
      ) : (
        <form onSubmit={verify} className="mt-4 space-y-3" noValidate>
          <p className="text-sm text-ink-soft">
            验证码已发送到 <span className="font-medium text-ink">{email}</span>，10 分钟内有效。
          </p>
          {process.env.NODE_ENV === "development" && (
            <p className="text-xs text-muted">开发环境：验证码打印在运行 npm run dev 的终端里。</p>
          )}
          <label htmlFor="login-code" className="text-sm text-ink-soft">
            6 位验证码
          </label>
          <input
            id="login-code"
            ref={codeRef}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            className="w-40 rounded-xl border border-line bg-paper/60 px-3 py-2.5 text-center text-lg tracking-[0.4em] tabular-nums focus:border-qing focus:outline-none"
          />
          {error && <p className="text-sm text-zhu">{error}</p>}
          <div className="flex flex-wrap items-center gap-4">
            <button type="submit" disabled={busy || code.length !== 6} className="rounded-full bg-qing px-5 py-2.5 text-paper disabled:opacity-60">
              {busy ? "正在验证…" : "登录"}
            </button>
            <button type="button" disabled={cooldown > 0 || busy} onClick={() => void sendCode()} className="text-sm text-qing disabled:text-muted">
              {cooldown > 0 ? `${cooldown} 秒后可重新发送` : "重新发送"}
            </button>
            <button type="button" onClick={() => setStep("email")} className="text-sm text-muted">
              换个邮箱
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
