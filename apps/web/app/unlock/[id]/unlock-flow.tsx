"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { TopicId } from "@wenshan/content";
import { LoginForm } from "@/components/login-form";
import { CrisisPanel, Notice } from "@/components/notice";
import { ApiError, api, type Me } from "@/lib/api";
import { PRICE_LABEL, topicById, topicsBundle } from "@/lib/content";
import { loadReading, saveReading, type StoredReading } from "@/lib/reading-store";

interface TriageView {
  decision: "proceed" | "reframe_suggested" | "block_paid" | "crisis";
  confirmedTopic: TopicId;
  topicMismatch: boolean;
  summary: string;
  reframe: string | null;
  missingInfo: string[];
  message: string;
}

type Step =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "login" }
  | { kind: "consent" }
  | { kind: "working"; label: string }
  | { kind: "triage"; readingId: string; triage: TriageView }
  | { kind: "error"; message: string };

const DELIVERABLES = [
  "从你的处境出发的解读，每处解释都标明依据的原文",
  "需要你在现实中核实的信息",
  "一个七天内可以尝试的行动：做什么、什么时间前做、用什么反馈来判断",
  "回看条件，以及同一件事的三次追问",
];

export function UnlockFlow({ clientId }: { clientId: string }) {
  const [reading, setReading] = useState<StoredReading | null>(null);
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [agreed, setAgreed] = useState(false);
  const [paying, setPaying] = useState(false);

  const checkLogin = useCallback(async () => {
    const r = loadReading(clientId);
    setReading(r);
    if (!r || r.revealed < 6) {
      setStep({ kind: "missing" });
      return;
    }
    const me = await api<Me>("/api/me");
    setStep(me.user ? { kind: "consent" } : { kind: "login" });
  }, [clientId]);

  useEffect(() => {
    void checkLogin().catch(() => setStep({ kind: "error", message: "网络异常，请刷新页面重试" }));
  }, [checkLogin]);

  async function uploadAndTriage(r: StoredReading) {
    setStep({ kind: "working", label: "正在确认题意…" });
    try {
      const { readingId } = await api<{ readingId: string }>("/api/readings", {
        body: {
          clientReadingId: r.id,
          question: r.question,
          topicId: r.topicId,
          topicOriginal: r.topicOriginal,
          context: r.context,
          tosses: r.tosses,
          consent: true,
        },
      });
      const triage = await api<TriageView>(`/api/readings/${readingId}/triage`, { body: {} });
      setStep({ kind: "triage", readingId, triage });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setStep({ kind: "login" });
      else setStep({ kind: "error", message: err instanceof ApiError ? err.message : "网络异常，请稍后再试" });
    }
  }

  async function switchTopic(readingId: string, topicId: TopicId) {
    if (!reading) return;
    setStep({ kind: "working", label: "正在更新主题…" });
    try {
      await api(`/api/readings/${readingId}`, { method: "PATCH", body: { topicId } });
      const next = { ...reading, topicId };
      saveReading(next);
      setReading(next);
      const triage = await api<TriageView>(`/api/readings/${readingId}/triage`, { body: {} });
      setStep({ kind: "triage", readingId, triage });
    } catch (err) {
      setStep({ kind: "error", message: err instanceof ApiError ? err.message : "网络异常，请稍后再试" });
    }
  }

  async function checkout(readingId: string) {
    setPaying(true);
    try {
      const { orderId, checkoutUrl } = await api<{ orderId: string; checkoutUrl: string | null }>("/api/orders", { body: { readingId } });
      window.location.assign(checkoutUrl ?? `/orders/${orderId}`);
    } catch (err) {
      setPaying(false);
      setStep({ kind: "error", message: err instanceof ApiError ? err.message : "暂时无法创建订单，请稍后再试" });
    }
  }

  if (step.kind === "loading") return <p className="text-sm text-muted">正在加载…</p>;
  if (step.kind === "missing") {
    return (
      <div className="space-y-3">
        <h1 className="font-serif text-2xl text-ink">找不到这一卦</h1>
        <p className="text-sm text-ink-soft">解锁报告需要先在这个浏览器里完成起卦。</p>
        <Link href="/ask" className="inline-block rounded-full bg-qing px-5 py-2 text-paper">
          重新开始
        </Link>
      </div>
    );
  }

  const r = reading!;
  const topic = topicById(r.topicId);

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs text-muted">解锁本次解读 · {topic.name}</p>
        <h1 className="mt-1 font-serif text-xl leading-8 text-ink">「{r.question}」</h1>
      </header>

      {step.kind === "login" && <LoginForm onDone={() => setStep({ kind: "consent" })} intro="购买前请先登录。登录后报告可以跨设备回看。" />}

      {step.kind === "consent" && (
        <section className="rounded-2xl border border-line bg-card p-5">
          <h2 className="font-serif text-lg text-ink">生成报告前，请确认</h2>
          <p className="mt-2 text-sm text-ink-soft">为了结合你的处境生成报告，以下内容会发送给模型服务方 OpenAI：</p>
          <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-ink-soft">
            <li>你写的问题和补充的背景</li>
            <li>所选主题与这一卦的卦象、原文</li>
          </ul>
          <p className="mt-2 text-sm text-ink-soft">
            你的邮箱不会发送给模型服务方。OpenAI 不会用这些数据训练模型，但会为防止滥用保留请求日志，最长 30 天。报告交付后保留 90 天，你可以随时导出或删除。
          </p>
          <label className="mt-4 flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-1 accent-qing" />
            我已了解，同意发送以上内容用于生成报告
          </label>
          <div className="mt-4 flex flex-wrap gap-4">
            <button
              type="button"
              disabled={!agreed}
              onClick={() => void uploadAndTriage(r)}
              className="rounded-full bg-qing px-5 py-2.5 text-paper disabled:opacity-50"
            >
              同意并确认题意
            </button>
            <Link href={`/r/${r.id}`} className="self-center text-sm text-muted">
              返回本次结果
            </Link>
          </div>
        </section>
      )}

      {step.kind === "working" && <p className="text-sm text-muted">{step.label}</p>}

      {step.kind === "error" && (
        <Notice tone="warn" title="出了点问题">
          <p>{step.message}</p>
          <button type="button" onClick={() => void checkLogin()} className="mt-2 text-sm font-medium text-qing underline underline-offset-4">
            重试
          </button>
        </Notice>
      )}

      {step.kind === "triage" && step.triage.decision === "crisis" && <CrisisPanel message={step.triage.message} help={topicsBundle.help} />}

      {step.kind === "triage" && step.triage.decision === "block_paid" && (
        <Notice tone="warn" title="这个问题暂时不提供付费报告">
          <p>{step.triage.message}</p>
          <Link href={`/r/${r.id}`} className="mt-2 inline-block text-sm font-medium text-qing underline underline-offset-4">
            返回本次卦象与原文
          </Link>
        </Notice>
      )}

      {step.kind === "triage" && (step.triage.decision === "proceed" || step.triage.decision === "reframe_suggested") && (
        <>
          <section className="rounded-2xl border border-line bg-card p-5">
            <h2 className="text-xs text-muted">我们理解你想问的是</h2>
            <p className="mt-2 font-serif text-lg leading-8 text-ink">{step.triage.summary}</p>
            {step.triage.reframe && (
              <p className="mt-3 border-l-2 border-lu pl-3 text-sm text-ink-soft">
                也可以换个你能掌握的问法：「{step.triage.reframe}」。报告会从你能做的部分出发。
              </p>
            )}
            {step.triage.missingInfo.length > 0 && (
              <div className="mt-3 text-sm text-ink-soft">
                <p>补充这些信息，报告会更贴合：{step.triage.missingInfo.join("；")}。</p>
                <Link href={`/ask?reading=${r.id}`} className="mt-1 inline-block text-qing underline underline-offset-4">
                  回去补充背景
                </Link>
              </div>
            )}
            {step.triage.topicMismatch && (
              <div className="mt-4 rounded-xl bg-paper-deep/60 p-3 text-sm">
                <p className="text-ink">这件事可能更接近「{topicById(step.triage.confirmedTopic).name}」。用哪个主题生成报告？</p>
                <div className="mt-2 flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => void switchTopic(step.readingId, step.triage.confirmedTopic)}
                    className="rounded-full border border-qing/60 px-4 py-1.5 text-qing"
                  >
                    改为{topicById(step.triage.confirmedTopic).name}
                  </button>
                  <span className="self-center text-muted">或保持「{topic.name}」直接继续</span>
                </div>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-qing/40 bg-card p-5">
            <h2 className="font-serif text-lg text-ink">一次付款 {PRICE_LABEL}</h2>
            <ul className="mt-3 space-y-1.5 text-sm text-ink">
              {DELIVERABLES.map((d) => (
                <li key={d} className="flex gap-2">
                  <span aria-hidden className="text-qing">
                    ·
                  </span>
                  {d}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted">
              以美元结算。付款后通常 30 秒内可以看到报告；如果 24 小时内没能交付，会自动原路退款，无需再次付款。
            </p>
            <button
              type="button"
              disabled={paying}
              onClick={() => void checkout(step.readingId)}
              className="mt-4 rounded-full bg-qing px-6 py-2.5 text-paper transition-colors hover:bg-qing-deep disabled:opacity-60"
            >
              {paying ? "正在前往支付…" : `去支付 ${PRICE_LABEL}`}
            </button>
          </section>
        </>
      )}
    </div>
  );
}
