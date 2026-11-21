"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Notice } from "@/components/notice";
import { ApiError, api } from "@/lib/api";

const CATEGORIES = [
  { id: "duplicate_charge_or_refund", label: "重复扣款或退款" },
  { id: "paid_not_delivered", label: "已付款未收到报告" },
  { id: "login_or_page_error", label: "登录或页面故障" },
  { id: "report_content", label: "报告内容问题" },
  { id: "other", label: "其他" },
] as const;
type Category = (typeof CATEGORIES)[number]["id"];

const REPORT_ISSUES = [
  { id: "bad_citation", label: "原文引用有误" },
  { id: "misunderstood", label: "误解了我的题意" },
  { id: "vague_action", label: "行动建议不具体" },
] as const;

export function SupportForm({ supportEmail }: { supportEmail: string | null }) {
  const params = useSearchParams();
  const preset = params.get("type");
  const orderId = params.get("order") ?? undefined;
  const reportId = params.get("report") ?? undefined;
  const errorCode = params.get("error") ?? undefined;
  const from = params.get("from") ?? undefined;

  const [category, setCategory] = useState<Category>(
    CATEGORIES.some((c) => c.id === preset) ? (preset as Category) : reportId ? "report_content" : "other",
  );
  const [issues, setIssues] = useState<string[]>([]);
  const [description, setDescription] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [includeQuestion, setIncludeQuestion] = useState(false);
  const [page, setPage] = useState<string | undefined>(from);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ ticketNo: string; linked: boolean } | null>(null);
  // 同一次填写用同一个幂等键：重复点击或网络重试不会生成两张工单
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

  useEffect(() => {
    if (!page && document.referrer) {
      try {
        const u = new URL(document.referrer);
        if (u.origin === window.location.origin) setPage(u.pathname);
      } catch {
        /* ignore */
      }
    }
  }, [page]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (description.trim().length < 5) {
      setError("请描述一下发生了什么（至少 5 个字）");
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ ticketNo: string; linkedOrder: boolean; linkedReport: boolean }>("/api/support", {
        body: {
          idempotencyKey,
          category,
          reportIssues: category === "report_content" ? issues : [],
          description: description.trim(),
          contactEmail: contactEmail.trim() || undefined,
          orderId,
          reportId,
          includeQuestion,
          diagnostics: { page, errorCode },
        },
      });
      setDone({ ticketNo: res.ticketNo, linked: res.linkedOrder || res.linkedReport });
    } catch (err) {
      if (err instanceof ApiError && err.code === "service_unavailable") {
        // 工单系统未就绪（例如数据库维护中）：给出备用邮箱，不让用户白填
        setError(supportEmail ? `暂时无法在线提交，请发邮件到 ${supportEmail} 说明情况。` : "暂时无法在线提交，请稍后再试。");
      } else setError(err instanceof ApiError ? err.message : "提交失败，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <section className="mt-6 rounded-2xl border border-qing/40 bg-card p-5" role="status">
        <p className="text-sm text-muted">已收到，工单号</p>
        <p className="mt-1 font-mono text-2xl tracking-wider text-ink">{done.ticketNo}</p>
        <p className="mt-3 text-sm text-ink-soft">
          请保存这个工单号。{done.linked ? "我们已关联到你的订单或报告。" : ""}
          {contactEmail ? "处理进展会发到你留下的邮箱。" : "没有留下邮箱的话，可以凭工单号再次联系我们。"}
          涉及退款的问题，核实后会原路退回，无需重复付款。
        </p>
        {supportEmail && <p className="mt-2 text-xs text-muted">也可以发邮件到 {supportEmail} 补充说明。</p>}
      </section>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="mt-6 space-y-5">
      <fieldset>
        <legend className="text-sm font-medium text-ink">遇到了什么问题？</legend>
        <div role="radiogroup" className="mt-2 flex flex-wrap gap-2">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={category === c.id}
              onClick={() => setCategory(c.id)}
              className={`rounded-full border px-4 py-1.5 text-sm ${
                category === c.id ? "border-qing bg-qing text-paper" : "border-line bg-card text-ink-soft hover:border-qing/60"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </fieldset>

      {category === "report_content" && (
        <fieldset>
          <legend className="text-sm text-ink-soft">报告哪里不对？（可多选）</legend>
          <div className="mt-2 flex flex-wrap gap-4">
            {REPORT_ISSUES.map((i) => (
              <label key={i.id} className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  className="accent-qing"
                  checked={issues.includes(i.id)}
                  onChange={(e) => setIssues((xs) => (e.target.checked ? [...xs, i.id] : xs.filter((x) => x !== i.id)))}
                />
                {i.label}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div>
        <label htmlFor="support-desc" className="text-sm font-medium text-ink">
          发生了什么
        </label>
        <textarea
          id="support-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
          rows={5}
          placeholder="例如：付款后页面一直显示正在生成；或者报告第二条的引用和解释对不上。"
          className="mt-2 w-full resize-none rounded-xl border border-line bg-card px-3 py-2.5 text-base focus:border-qing focus:outline-none"
        />
        <p className="mt-1 text-xs text-muted">请不要写真实姓名、生日、地址或他人的身份信息。</p>
      </div>

      <div>
        <label htmlFor="support-email" className="text-sm text-ink-soft">
          回复邮箱（可选）
        </label>
        <input
          id="support-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
          className="mt-1 w-full rounded-xl border border-line bg-card px-3 py-2 text-base focus:border-qing focus:outline-none"
        />
      </div>

      {(orderId || reportId) && (
        <label className="flex items-start gap-2 text-sm text-ink">
          <input type="checkbox" className="mt-1 accent-qing" checked={includeQuestion} onChange={(e) => setIncludeQuestion(e.target.checked)} />
          附上这次的问题原文，方便我们核对（可以不选）
        </label>
      )}

      <p className="text-xs text-muted">
        提交时会自动附上有限的诊断信息：所在页面{errorCode ? `、错误编号 ${errorCode}` : ""}和网站版本；已登录时会关联你名下的订单或报告。
      </p>

      {error && <p className="text-sm text-zhu">{error}</p>}
      <button type="submit" disabled={busy} className="rounded-full bg-qing px-6 py-2.5 text-paper disabled:opacity-60">
        {busy ? "正在提交…" : "提交"}
      </button>
      {!supportEmail && null}
      <Notice title="付款问题会怎么处理">
        重复扣款、已付款未收到报告等问题，我们核实后通过原订单原路退款；24 小时内未交付的订单也会自动退款。
      </Notice>
    </form>
  );
}
