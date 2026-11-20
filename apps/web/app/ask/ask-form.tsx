"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { runLocalTriage, type LocalTriageResult, type TopicId } from "@wenshan/content";
import { sampleTosses } from "@wenshan/iching-core";
import { CrisisPanel, Notice } from "@/components/notice";
import { isTopicId, topicById, topics, topicsBundle } from "@/lib/content";
import { clearDraft, loadDraft, loadReading, newReading, saveReading, type StoredReading } from "@/lib/reading-store";
import { track } from "@/lib/track";

const MAX_LENGTH = 200;

export function AskForm() {
  const router = useRouter();
  const params = useSearchParams();
  const editId = params.get("reading");
  const presetTopic = params.get("topic");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const triageRef = useRef<HTMLDivElement>(null);

  const [existing, setExisting] = useState<StoredReading | null>(null);
  const [question, setQuestion] = useState("");
  const [topicId, setTopicId] = useState<TopicId | null>(isTopicId(presetTopic) ? presetTopic : null);
  const [context, setContext] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<{ question?: string; topic?: string }>({});
  const [triage, setTriage] = useState<LocalTriageResult | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [askSameMatter, setAskSameMatter] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);

  // 首次挂载：编辑已有起卦，或接住首页草稿
  useEffect(() => {
    if (editId) {
      const r = loadReading(editId);
      if (r) {
        setExisting(r);
        setQuestion(r.question);
        setTopicId(r.topicId);
        setContext(r.context);
        return;
      }
    }
    const draft = loadDraft();
    if (draft) {
      setQuestion(draft.question);
      if (draft.topicId && !isTopicId(presetTopic)) setTopicId(draft.topicId);
      clearDraft();
    }
  }, [editId, presetTopic]);

  // 分流提示出现在表单底部；手机上自动滚到可见位置，避免用户错过求助指引
  useEffect(() => {
    if (triage && (triage.crisis || triage.notices.length > 0)) {
      triageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [triage]);

  const topic = topicId ? topicById(topicId) : null;
  const trimmed = question.trim();

  function onQuestionChange(v: string) {
    setQuestion(v);
    setTriage(null);
    setAcknowledged(false);
    setAskSameMatter(false);
    if (errors.question) setErrors((e) => ({ ...e, question: undefined }));
  }

  function chooseTopic(id: TopicId) {
    setTopicId(id);
    setTriage(null);
    setAcknowledged(false);
    if (errors.topic) setErrors((e) => ({ ...e, topic: undefined }));
  }

  function filledContext(): Record<string, string> {
    if (!topic) return {};
    const keys = new Set(topic.contextFields.map((f) => f.key));
    return Object.fromEntries(Object.entries(context).filter(([k, v]) => keys.has(k) && v.trim()).map(([k, v]) => [k, v.trim()]));
  }

  function go(reading: StoredReading) {
    if (!saveReading(reading)) {
      setStorageFailed(true);
      return;
    }
    router.push(reading.revealed >= 6 ? `/r/${reading.id}` : `/cast/${reading.id}`);
  }

  function startNew() {
    const reading = newReading({ question: trimmed, topicId: topicId!, context: filledContext(), tosses: sampleTosses() });
    track("ask_submitted", { topic: topicId, fields: Object.keys(reading.context).length, edited: Boolean(existing) });
    go(reading);
  }

  function keepCast() {
    if (!existing) return;
    go({ ...existing, question: trimmed, topicId: topicId!, context: filledContext() });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit(acknowledged);
  }

  function submit(ack: boolean) {
    const next: typeof errors = {};
    if (trimmed.length < 4) next.question = "请用一句话写下这件事，至少 4 个字。";
    if (!topicId) next.topic = "请选一个最贴近的主题。";
    setErrors(next);
    if (next.question) textareaRef.current?.focus();
    if (next.question || next.topic) return;

    const result = runLocalTriage(trimmed, topicsBundle.triage, topic ?? undefined);
    setTriage(result);
    if (result.crisis) return;
    if (result.notices.length > 0 && !ack) return;
    setAcknowledged(ack);

    if (existing) {
      // 同一件事只保留一组爻值：只改主题或背景时复用；改了问题先确认（PRD §4）
      if (trimmed === existing.question) keepCast();
      else setAskSameMatter(true);
      return;
    }
    startNew();
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl text-ink">{existing ? "修改问题或主题" : "写下你在意的一件事"}</h1>
        <p className="mt-1 text-sm text-muted">一次只问一件事。问得越具体，卦象越容易读出可以做的下一步。</p>
      </div>

      <fieldset>
        <legend className="text-sm font-medium text-ink">这件事属于哪一类？</legend>
        <div role="radiogroup" className="mt-2 flex flex-wrap gap-2">
          {topics.map((t) => {
            const selected = t.id === topicId;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => chooseTopic(t.id)}
                className={`rounded-full border px-4 py-1.5 text-sm transition-colors ${
                  selected ? "border-qing bg-qing text-paper" : "border-line bg-card text-ink-soft hover:border-qing/60"
                }`}
              >
                {t.name}
              </button>
            );
          })}
        </div>
        {errors.topic && <p className="mt-2 text-sm text-zhu">{errors.topic}</p>}
        {topic && <p className="mt-2 text-sm text-muted">{topic.tagline}</p>}
      </fieldset>

      <div>
        <label htmlFor="question" className="text-sm font-medium text-ink">
          你的问题
        </label>
        <textarea
          id="question"
          ref={textareaRef}
          value={question}
          onChange={(e) => onQuestionChange(e.target.value)}
          maxLength={MAX_LENGTH}
          rows={4}
          aria-invalid={Boolean(errors.question)}
          aria-describedby="question-hint"
          placeholder={topic ? `例如：${topic.examples[0]}` : "例如：有两个工作机会，我看重的是什么？"}
          className={`mt-2 w-full resize-none rounded-xl border bg-card px-3 py-2.5 text-base text-ink placeholder:text-muted/80 focus:outline-none ${
            errors.question ? "border-zhu" : "border-line focus:border-qing"
          }`}
        />
        <div id="question-hint" className="mt-1 flex justify-between gap-3 text-xs text-muted">
          <span>请省略真实姓名、生日、地址和他人的身份信息。</span>
          <span className="shrink-0">
            {question.length}/{MAX_LENGTH}
          </span>
        </div>
        {errors.question && <p className="mt-1 text-sm text-zhu">{errors.question}</p>}

        {topic && (
          <div className="mt-3">
            <p className="text-xs text-muted">可以参考这样问：</p>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {topic.examples.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => onQuestionChange(ex)}
                  className="rounded-lg bg-paper-deep/70 px-3 py-1.5 text-left text-sm text-ink-soft hover:bg-lu-soft"
                >
                  {ex}
                </button>
              ))}
            </div>
            <p className="mt-3 border-l-2 border-lu pl-3 text-sm text-ink-soft">{topic.clarifyHint}</p>
          </div>
        )}
      </div>

      {topic && topic.contextFields.length > 0 && (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-ink">
            补充背景 <span className="font-normal text-muted">（都可以跳过）</span>
          </legend>
          {[...topic.contextFields]
            .sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)))
            .map((f) => (
              <div key={f.key}>
                <label htmlFor={`ctx-${f.key}`} className="text-sm text-ink-soft">
                  {f.label}
                  {f.primary && <span className="ml-1.5 rounded bg-lu-soft px-1.5 py-0.5 text-xs text-qing">关键背景</span>}
                </label>
                <input
                  id={`ctx-${f.key}`}
                  value={context[f.key] ?? ""}
                  onChange={(e) => setContext((c) => ({ ...c, [f.key]: e.target.value }))}
                  maxLength={120}
                  placeholder={f.placeholder}
                  className="mt-1 w-full rounded-xl border border-line bg-card px-3 py-2 text-base text-ink placeholder:text-muted/70 focus:border-qing focus:outline-none"
                />
              </div>
            ))}
        </fieldset>
      )}

      <div ref={triageRef} className="scroll-mt-4" />
      {triage?.crisis && (
        <CrisisPanel message={triage.notices[0]?.message ?? ""} help={topicsBundle.help} />
      )}

      {triage && !triage.crisis && triage.notices.length > 0 && !askSameMatter && (
        <div className="space-y-3">
          {triage.notices.map((n) => (
            <Notice key={n.id} tone="warn" title={n.title}>
              <p>{n.message}</p>
              {n.suggestion && (
                <div className="mt-2 rounded-lg bg-card/80 p-3">
                  <p className="text-xs text-muted">例如把「{n.suggestion.from}」改成：</p>
                  <p className="mt-1 text-ink">「{n.suggestion.to}」</p>
                  <button
                    type="button"
                    onClick={() => onQuestionChange(n.suggestion!.to)}
                    className="mt-2 text-sm font-medium text-qing underline underline-offset-4"
                  >
                    用这个问法
                  </button>
                </div>
              )}
            </Notice>
          ))}
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => textareaRef.current?.focus()}
              className="rounded-full border border-qing/60 px-4 py-2 text-sm text-qing"
            >
              修改问题
            </button>
            <button type="button" onClick={() => submit(true)} className="rounded-full bg-qing px-4 py-2 text-sm text-paper">
              按原问法继续
            </button>
          </div>
        </div>
      )}

      {askSameMatter && existing && (
        <section role="alertdialog" aria-labelledby="same-matter" className="rounded-2xl border border-line bg-card p-4">
          <h2 id="same-matter" className="font-medium text-ink">
            这还是同一件事吗？
          </h2>
          <p className="mt-1 text-sm text-ink-soft">同一件事只保留一组爻值。如果换了一件事，会重新起一卦。</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button type="button" onClick={keepCast} className="rounded-full bg-qing px-4 py-2 text-sm text-paper">
              只是改了措辞，保留这一卦
            </button>
            <button type="button" onClick={startNew} className="rounded-full border border-qing/60 px-4 py-2 text-sm text-qing">
              换了一件事，重新起卦
            </button>
          </div>
        </section>
      )}

      {storageFailed && (
        <Notice tone="warn" title="浏览器没有保存成功">
          当前浏览器禁止了本地存储（例如部分无痕模式），刷新后卦象可能无法恢复。可以换一个浏览器窗口再试。
        </Notice>
      )}

      {!triage?.crisis && !(triage && triage.notices.length > 0 && !acknowledged) && !askSameMatter && (
        <div className="flex flex-wrap items-center gap-4 pb-[env(safe-area-inset-bottom)]">
          <button type="submit" className="rounded-full bg-qing px-6 py-3 text-base text-paper transition-colors hover:bg-qing-deep">
            {existing ? "保存" : "确认，开始起卦"}
          </button>
          {existing ? (
            <Link href={`/r/${existing.id}`} className="text-sm text-muted hover:text-qing">
              取消
            </Link>
          ) : (
            <Link href="/rules" className="text-sm text-muted hover:text-qing">
              起卦规则
            </Link>
          )}
        </div>
      )}
    </form>
  );
}
