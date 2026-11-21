"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { HexagramFigure } from "@/components/hexagram-figure";
import { LoginForm } from "@/components/login-form";
import { CrisisPanel, Notice } from "@/components/notice";
import { ApiError, api, formatDate } from "@/lib/api";
import { topicsBundle } from "@/lib/content";

interface Action {
  what: string;
  by_when: string;
  feedback_signal: string;
}

/** 旧版报告（report@1，第四轮之前生成） */
interface LegacyContent {
  question_summary: string;
  situation: string;
  observations: { angle: string; text: string; citations: string[] }[];
  to_verify: { item: string; how: string }[];
  seven_day_action: Action;
  review_condition: string;
  followup_suggestions: string[];
}

/** 简版报告（report@2） */
interface ConciseContent {
  takeaway: string;
  next_step: { trigger: string; action: string; signal: string };
  basis: { citation: string; text: string }[];
  artifact: { kind: "message" | "opener" | "checklist"; title: string; content: string } | null;
  followup_suggestions: string[];
}

type Report = {
  id: string;
  orderId: string;
  createdAt: string;
  expiresAt: string;
  topicName: string;
  question: string;
  cast: { primaryName: string; changedName: string | null; moving: string[]; lines: number[] };
  citations: Record<string, { title: string; text: string; sourceUrl: string | null }>;
  followups: {
    id: string;
    seq: number;
    status: string;
    question: string;
    answer: { is_same_matter: boolean; answer: string; adjusted_action: Action | null; citations: string[] } | null;
  }[];
  followupsRemaining: number;
  versions: Record<string, string>;
} & ({ format: "v2"; content: ConciseContent } | { format: "v1"; content: LegacyContent });

const DELETE_REASON: Record<string, string> = {
  user_deleted: "你已经删除了这份报告。",
  expired: "这份报告已超过保留期限，内容已清除。",
  refunded: "这笔订单已退款，报告已收回。",
  disputed: "这笔付款存在支付争议，报告暂停访问。",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-card p-5 break-inside-avoid print:border-0 print:p-0">
      <h2 className="text-xs tracking-wide text-muted">{title}</h2>
      <div className="mt-2 text-[15px] leading-7 text-ink">{children}</div>
    </section>
  );
}

function ActionBlock({ a }: { a: Action }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
      <dt className="text-muted">做什么</dt>
      <dd>{a.what}</dd>
      <dt className="text-muted">何时前</dt>
      <dd>{a.by_when}</dd>
      <dt className="text-muted">怎么判断</dt>
      <dd>{a.feedback_signal}</dd>
    </dl>
  );
}

function Citation({ id, c }: { id: string; c: Report["citations"][string] | undefined }) {
  if (!c) return <span className="text-xs text-muted">{id}</span>;
  return (
    <details className="inline-block align-top text-sm">
      <summary className="cursor-pointer rounded bg-lu-soft px-2 py-0.5 text-xs text-qing print:hidden">
        {c.title}
      </summary>
      <span className="mt-1 block font-serif text-ink">{c.text}</span>
      <span className="block text-xs text-muted">
        {id}
        {c.sourceUrl && (
          <>
            {" · "}
            <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              出处
            </a>
          </>
        )}
      </span>
    </details>
  );
}

/** 剪贴板 API 被拒绝（例如页面没有焦点、浏览器权限）时退回"选中 + 复制命令" */
function legacyCopy(text: string): boolean {
  const t = document.createElement("textarea");
  t.value = text;
  t.setAttribute("readonly", "");
  t.style.position = "fixed";
  t.style.opacity = "0";
  document.body.appendChild(t);
  t.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  t.remove();
  return ok;
}

/**
 * 复制按钮：成功时按钮变成"✓ 已复制"并有文字提示；两种复制方式都失败时，
 * 自动选中材料文字（targetId），提示长按手动复制。
 */
function CopyButton({ text, targetId, label = "复制" }: { text: string; targetId?: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) ok = legacyCopy(text);
    if (!ok && targetId) {
      const el = document.getElementById(targetId);
      const sel = window.getSelection();
      if (el && sel) {
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    setState(ok ? "copied" : "failed");
    window.setTimeout(() => setState("idle"), ok ? 2500 : 6000);
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2 print:hidden">
      <button
        type="button"
        onClick={() => void copy()}
        className={`rounded-full border px-4 py-1.5 text-sm ${state === "copied" ? "border-qing bg-qing text-paper" : "border-qing/60 text-qing hover:bg-lu-soft/60"}`}
      >
        {state === "copied" ? "✓ 已复制" : label}
      </button>
      <span role="status" aria-live="polite" className="text-xs text-muted">
        {state === "copied" ? "已复制到剪贴板，可以直接粘贴" : state === "failed" ? "没能自动复制，文字已选中，请长按或右键复制" : ""}
      </span>
    </span>
  );
}

const ARTIFACT_LABEL: Record<NonNullable<ConciseContent["artifact"]>["kind"], string> = {
  message: "可以直接发的消息",
  opener: "谈话开场",
  checklist: "选择清单",
};

/** 简版报告：一句判断 → 下一步 → 可复制材料 → 为什么这样看（默认折叠） */
function ConciseBody({ report, c }: { report: Report; c: ConciseContent }) {
  const bits = report.cast.lines.map((v) => (v === 7 || v === 9 ? 1 : 0)) as (0 | 1)[];
  const moving = report.cast.lines.flatMap((v, i) => (v === 6 || v === 9 ? [i + 1] : []));
  return (
    <>
      <section aria-label="一句判断">
        <p className="font-serif text-[22px] leading-9 text-ink">{c.takeaway}</p>
      </section>

      <section aria-label="下一步" className="rounded-2xl border border-qing/40 bg-card p-5 break-inside-avoid">
        <h2 className="text-xs tracking-wide text-qing">下一步</h2>
        <dl className="mt-2 space-y-3 text-[15px] leading-7 text-ink">
          <div>
            <dt className="text-xs text-muted">什么时候</dt>
            <dd>{c.next_step.trigger}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">做什么</dt>
            <dd>{c.next_step.action}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">怎么判断进展</dt>
            <dd>{c.next_step.signal}</dd>
          </div>
        </dl>
      </section>

      {c.artifact && (
        <section aria-label={c.artifact.title} className="rounded-2xl border border-line bg-card p-5 break-inside-avoid">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-xs tracking-wide text-muted">{c.artifact.title || ARTIFACT_LABEL[c.artifact.kind]}</h2>
          </div>
          <p id="report-artifact" className="mt-2 whitespace-pre-wrap rounded-xl bg-paper/70 p-3 text-[15px] leading-7 text-ink select-all">
            {c.artifact.content}
          </p>
          {c.artifact.content.includes("【") && <p className="mt-2 text-xs text-muted">【】里的内容换成你的实际情况再发。</p>}
          <div className="mt-3">
            <CopyButton text={c.artifact.content} targetId="report-artifact" />
          </div>
        </section>
      )}

      <details className="group rounded-2xl border border-line bg-card/60 break-inside-avoid" data-print-open>
        <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-[15px] text-ink">
          <span>为什么这样看</span>
          <span aria-hidden className="text-muted transition-transform group-open:rotate-90">
            ›
          </span>
        </summary>
        <div className="space-y-4 px-5 pb-5">
          <div className="flex items-center gap-4">
            <HexagramFigure bits={bits} moving={moving} size="sm" label={`${report.cast.primaryName}卦`} />
            <p className="text-sm text-ink-soft">
              本卦「{report.cast.primaryName}」{report.cast.changedName ? ` → 变卦「${report.cast.changedName}」` : ""}
              {report.cast.moving.length ? ` · 动爻 ${report.cast.moving.join("、")}` : " · 无动爻"}
            </p>
          </div>
          {c.basis.map((b) => {
            const src = report.citations[b.citation];
            return (
              <div key={b.citation} className="border-l-2 border-lu pl-3">
                {src && (
                  <p className="font-serif text-lg leading-8 text-ink">
                    <span className="mr-2 font-sans text-xs text-muted">{src.title}</span>
                    {src.text}
                  </p>
                )}
                <p className="mt-1 text-[15px] leading-7 text-ink-soft">{b.text}</p>
                <p className="mt-1 text-xs text-muted">
                  {b.citation}
                  {src?.sourceUrl && (
                    <>
                      {" · "}
                      <a href={src.sourceUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                        出处
                      </a>
                    </>
                  )}
                </p>
              </div>
            );
          })}
        </div>
      </details>
    </>
  );
}

/** 旧版报告（report@1）：保留原来的呈现，照常可读、可导出、可追问 */
function LegacyBody({ report, c }: { report: Report; c: LegacyContent }) {
  const bits = report.cast.lines.map((v) => (v === 7 || v === 9 ? 1 : 0)) as (0 | 1)[];
  const moving = report.cast.lines.flatMap((v, i) => (v === 6 || v === 9 ? [i + 1] : []));
  return (
    <>
      <div className="flex items-center gap-4">
        <HexagramFigure bits={bits} moving={moving} size="sm" label={`${report.cast.primaryName}卦`} />
        <p className="text-sm text-ink-soft">
          本卦「{report.cast.primaryName}」{report.cast.changedName ? ` → 变卦「${report.cast.changedName}」` : ""}
          {report.cast.moving.length ? ` · 动爻 ${report.cast.moving.join("、")}` : " · 无动爻"}
        </p>
      </div>
      <Section title="你想弄清的事">{c.question_summary}</Section>
      <Section title="处境">{c.situation}</Section>
      <Section title="结合问题看卦">
        <div className="space-y-4">
          {c.observations.map((o, i) => (
            <div key={i}>
              <p className="font-medium text-qing">{o.angle}</p>
              <p className="mt-1">{o.text}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {o.citations.map((id) => (
                  <Citation key={id} id={id} c={report.citations[id]} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>
      <Section title="需要核实">
        <ul className="space-y-2">
          {c.to_verify.map((v, i) => (
            <li key={i}>
              <p>{v.item}</p>
              <p className="text-sm text-ink-soft">{v.how}</p>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="七天行动">
        <ActionBlock a={c.seven_day_action} />
      </Section>
      <Section title="回看条件">{c.review_condition}</Section>
    </>
  );
}

export function ReportView({ reportId }: { reportId: string }) {
  const [state, setState] = useState<"loading" | "login" | "notfound" | "error" | "ok">("loading");
  const [report, setReport] = useState<Report | null>(null);
  const [deleted, setDeleted] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [submitKey, setSubmitKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [crisis, setCrisis] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<Report | { deleted: true; reason: string | null }>(`/api/reports/${reportId}`);
      if ("deleted" in data) {
        setDeleted(DELETE_REASON[data.reason ?? ""] ?? "这份报告已不可查看。");
        setReport(null);
      } else {
        setReport(data);
      }
      setState("ok");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setState("login");
      else if (err instanceof ApiError && err.status === 404) setState("notfound");
      else setState("error");
    }
  }, [reportId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 导出 / 打印时展开"为什么这样看"等折叠内容，打印完恢复
  useEffect(() => {
    const opened: HTMLDetailsElement[] = [];
    const before = () => {
      document.querySelectorAll<HTMLDetailsElement>("details[data-print-open]").forEach((d) => {
        if (!d.open) {
          d.open = true;
          opened.push(d);
        }
      });
    };
    const after = () => opened.splice(0).forEach((d) => (d.open = false));
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);

  // 有追问正在生成时轮询
  useEffect(() => {
    if (!report?.followups.some((f) => f.status === "queued")) return;
    const t = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(t);
  }, [report, load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setCrisis(null);
    if (question.trim().length < 2) {
      setFormError("请写下你想追问的内容");
      return;
    }
    // 同一次提交用同一个幂等键，连点或网络重试不会扣两次
    const key = submitKey ?? crypto.randomUUID();
    setSubmitKey(key);
    setSubmitting(true);
    try {
      const res = await api<{ status: "queued" } | { status: "crisis"; message: string }>(`/api/reports/${reportId}/followups`, {
        body: { question: question.trim(), idempotencyKey: key },
      });
      if (res.status === "crisis") setCrisis(res.message);
      else setQuestion("");
      setSubmitKey(null);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "提交失败，请稍后再试");
    } finally {
      setSubmitting(false);
    }
  }

  async function remove() {
    try {
      await api(`/api/reports/${reportId}`, { method: "DELETE" });
      setDeleted(DELETE_REASON.user_deleted!);
      setReport(null);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "删除失败，请稍后再试");
    }
  }

  if (state === "loading") return <p className="text-sm text-muted">正在打开报告…</p>;
  if (state === "login") return <LoginForm onDone={() => void load()} intro="登录后查看你的报告。" />;
  if (state === "notfound") return <p className="text-sm text-ink-soft">没有找到这份报告。请确认登录的是购买时使用的邮箱。</p>;
  if (state === "error") return <p className="text-sm text-zhu">网络异常，请刷新页面重试。</p>;
  if (deleted || !report) {
    return (
      <div className="space-y-4">
        <p className="text-ink-soft">{deleted}</p>
        <Link href="/me" className="text-sm text-qing underline underline-offset-4">
          我的报告
        </Link>
      </div>
    );
  }

  const suggestions = report.content.followup_suggestions;

  return (
    <article className="space-y-5">
      <header className="space-y-1">
        <p className="text-xs text-muted">
          {report.topicName} · 生成于 {formatDate(report.createdAt)}
          {report.format === "v1" ? " · 旧版报告" : ""}
        </p>
        <h1 className="font-serif text-lg leading-8 text-ink-soft">「{report.question}」</h1>
      </header>

      {report.format === "v2" ? <ConciseBody report={report} c={report.content} /> : <LegacyBody report={report} c={report.content} />}

      <section className="space-y-3 print:hidden" aria-label="追问">
        <h2 className="text-sm text-muted">同一件事的追问</h2>
        {report.followups.map((f) => (
          <div key={f.id} className="rounded-2xl border border-line bg-card p-4 text-[15px] leading-7">
            <p className="text-sm text-muted">第 {f.seq} 次追问</p>
            <p className="mt-1 text-ink">{f.question}</p>
            {f.status === "queued" && <p className="mt-2 text-sm text-muted">正在回答…</p>}
            {f.status === "failed" && <p className="mt-2 text-sm text-zhu">这次没能生成回答，次数已退还，可以换个说法再问。</p>}
            {f.answer && (
              <div className="mt-2 border-l-2 border-lu pl-3">
                <p className="text-ink">{f.answer.answer}</p>
                {f.status === "rejected" && <p className="mt-1 text-xs text-muted">这次没有扣除追问次数。</p>}
                {f.answer.adjusted_action && (
                  <div className="mt-2 text-sm">
                    <p className="text-muted">调整后的行动</p>
                    <ActionBlock a={f.answer.adjusted_action} />
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {crisis && <CrisisPanel message={crisis} help={topicsBundle.help} />}

        {report.followupsRemaining > 0 ? (
          <form onSubmit={submit} className="rounded-2xl border border-line bg-card p-4">
            <label htmlFor="followup" className="text-sm text-ink-soft">
              就这件事继续问（剩余 {report.followupsRemaining} 次）
            </label>
            <textarea
              id="followup"
              value={question}
              onChange={(e) => {
                setQuestion(e.target.value);
                setSubmitKey(null);
              }}
              maxLength={200}
              rows={3}
              className="mt-2 w-full resize-none rounded-xl border border-line bg-paper/60 px-3 py-2 text-base focus:border-qing focus:outline-none"
            />
            {suggestions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {suggestions.map((s) => (
                  <button key={s} type="button" onClick={() => setQuestion(s)} className="rounded-lg bg-paper-deep/70 px-3 py-1 text-left text-sm text-ink-soft">
                    {s}
                  </button>
                ))}
              </div>
            )}
            {formError && <p className="mt-2 text-sm text-zhu">{formError}</p>}
            <button type="submit" disabled={submitting} className="mt-3 rounded-full bg-qing px-5 py-2 text-paper disabled:opacity-60">
              {submitting ? "正在提交…" : "追问"}
            </button>
          </form>
        ) : (
          <p className="text-sm text-muted">三次追问已经用完。</p>
        )}
      </section>

      <footer className="space-y-3 border-t border-line pt-4 print:hidden">
        <p className="text-xs text-muted">报告保留到 {formatDate(report.expiresAt)}，到期后自动清除。你可以先导出，也可以随时删除。</p>
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => window.print()} className="rounded-full border border-qing/60 px-4 py-2 text-sm text-qing">
            导出 / 打印
          </button>
          {!confirmDelete ? (
            <button type="button" onClick={() => setConfirmDelete(true)} className="rounded-full px-4 py-2 text-sm text-muted hover:text-zhu">
              删除报告
            </button>
          ) : (
            <Notice tone="warn" title="确定删除吗？">
              <p>删除后问题、报告和追问会被清除，无法恢复，剩余追问次数也会作废。</p>
              <div className="mt-2 flex gap-3">
                <button type="button" onClick={() => void remove()} className="rounded-full bg-zhu px-4 py-1.5 text-sm text-paper">
                  确定删除
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)} className="text-sm text-ink-soft">
                  取消
                </button>
              </div>
            </Notice>
          )}
        </div>
        <Link href={`/support?type=report_content&report=${report.id}&from=/reports`} className="inline-block text-sm text-qing underline underline-offset-4">
          反馈这份报告
        </Link>
        <p className="text-[11px] text-muted/80">
          依据版本：{Object.entries(report.versions).map(([k, v]) => `${k} ${v}`).join(" · ")}
        </p>
      </footer>
    </article>
  );
}
