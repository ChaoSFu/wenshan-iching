"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { saveDraft } from "@/lib/reading-store";

/** 首页提问入口：问题只存进 sessionStorage 草稿，不放进 URL。 */
export function QuestionStarter() {
  const router = useRouter();
  const [question, setQuestion] = useState("");

  function start(e: React.FormEvent) {
    e.preventDefault();
    if (question.trim()) saveDraft({ question: question.trim() });
    router.push("/ask");
  }

  return (
    <form onSubmit={start} className="rounded-2xl border border-line bg-card/90 p-4 shadow-sm backdrop-blur sm:p-5">
      <label htmlFor="home-question" className="font-serif text-lg text-ink">
        写下你正在关心的一件事
      </label>
      <textarea
        id="home-question"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        maxLength={200}
        rows={3}
        placeholder="例如：有两个工作机会，我看重的是什么？"
        className="mt-3 w-full resize-none rounded-xl border border-line bg-paper/60 px-3 py-2.5 text-base text-ink placeholder:text-muted/80 focus:border-qing focus:outline-none"
      />
      <div className="mt-3 flex flex-wrap gap-3">
        <button
          type="submit"
          className="flex-1 rounded-full bg-qing px-5 py-2.5 text-base text-paper transition-colors hover:bg-qing-deep sm:flex-none"
        >
          开始起卦
        </button>
        <Link
          href="/samples"
          className="flex-1 rounded-full border border-qing/60 px-5 py-2.5 text-center text-base text-qing transition-colors hover:bg-lu-soft sm:flex-none"
        >
          查看样例
        </Link>
      </div>
      <p className="mt-3 text-xs text-muted">无需注册。问题只保存在你这个浏览器标签页里。</p>
    </form>
  );
}
