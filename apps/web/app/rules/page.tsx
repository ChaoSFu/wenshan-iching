import type { Metadata } from "next";
import corpusJson from "@wenshan/content/generated/corpus.json";
import type { CorpusBundle } from "@wenshan/content";
import { CAST_RULE_VERSION, HEX_TABLE_VERSION, SELECTION_RULE_VERSION } from "@wenshan/iching-core";
import { PageShell } from "@/components/site-chrome";
import { topicsBundle } from "@/lib/content";

const corpus = corpusJson as unknown as CorpusBundle;

export const metadata: Metadata = {
  title: "起卦与选文规则",
  description: "问山采用三枚钱币起卦，并按动爻数量选取《周易》原文。本页说明具体规则、适用范围与典籍来源。",
};

const CAST_ROWS = [
  ["6", "老阴", "动", "阳", "1/8"],
  ["7", "少阳", "静", "阳", "3/8"],
  ["8", "少阴", "静", "阴", "3/8"],
  ["9", "老阳", "动", "阴", "1/8"],
];

const SELECTION_ROWS = [
  ["0", "显示本卦卦辞，并说明这次没有动爻。"],
  ["1", "本卦卦辞提供背景，突出对应的爻辞；变卦卦辞可以展开查看。"],
  ["2–6", "从下到上列出所有动爻的爻辞，另列本卦和变卦的卦辞。多条原文提供不同的观察角度。"],
  ["乾或坤六爻全变", "另外提供乾卦「用九」或坤卦「用六」作为补充原文。"],
];

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="mt-3 overflow-x-auto rounded-xl border border-line bg-card">
      <table className="w-full text-left text-sm">
        <thead className="bg-paper-deep/60 text-xs text-muted">
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="px-3 py-2 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r[0]} className="border-t border-line/70">
              {r.map((c, i) => (
                <td key={i} className="px-3 py-2 align-top text-ink">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function RulesPage() {
  const reviewed = Object.values(corpus.entries).filter((e) => e.reviewStatus === "reviewed").length;
  const total = Object.values(corpus.entries).length;
  return (
    <PageShell>
      <h1 className="font-serif text-2xl text-ink">起卦与选文规则</h1>

      <section className="mt-8">
        <h2 className="font-serif text-lg text-ink">三枚钱币起卦</h2>
        <p className="mt-2 text-sm text-ink-soft">
          每轮独立掷三枚公平钱币，正面记 3，反面记 2，三枚相加得到一爻。六轮自下而上，依次得到初爻到上爻。六轮钱币在开始时一次抽好，逐轮显示和「一次完成」使用同一批结果。
        </p>
        <Table head={["合计", "本卦爻", "是否变化", "变卦对应爻", "单轮概率"]} rows={CAST_ROWS} />
        <p className="mt-2 text-xs text-muted">按文王六十四卦序查出本卦与变卦。</p>
      </section>

      <section className="mt-8">
        <h2 className="font-serif text-lg text-ink">免费解读怎样选原文</h2>
        <Table head={["动爻数", "选文规则"]} rows={SELECTION_ROWS} />
      </section>

      <section className="mt-8">
        <h2 className="font-serif text-lg text-ink">适用范围</h2>
        <p className="mt-2 text-sm text-ink-soft">
          以上是问山采用的读法。历代解《易》的方法不止一种，例如多爻变动时，朱熹《易学启蒙》有不同的取法；纳甲六爻、梅花易数、生辰八字也是各自不同的体系。问山首版只采用本页这一种，并在每次结果里记录所用规则的版本。
        </p>
        <p className="mt-2 text-sm text-ink-soft">
          卦象提供的是反思与观察的角度，不预测结果。涉及疾病、投资收益、法律结果或人身安全的问题，请优先寻求相应的专业帮助。
        </p>
      </section>

      <section className="mt-8">
        <h2 className="font-serif text-lg text-ink">典籍来源</h2>
        <p className="mt-2 text-sm text-ink-soft">
          卦辞、爻辞、用九、用六与彖传、象传取自维基文库《周易》，每一卦记录了所依据的页面修订版本，原文属公有领域。简体字由繁体原文转换而来，正在逐条人工对勘（已对勘 {reviewed}/{total} 条）。白话注释与主题提示为问山自行撰写，与原文分开保存。
        </p>
      </section>

      <section className="mt-8 rounded-2xl bg-paper-deep/60 p-4 text-xs text-muted">
        <p>
          规则版本：起卦 {CAST_RULE_VERSION} · 卦序 {HEX_TABLE_VERSION} · 选文 {SELECTION_RULE_VERSION}
        </p>
        <p className="mt-1">
          内容版本：典籍 {corpus.version} · 主题与分流 {topicsBundle.version}
        </p>
      </section>
    </PageShell>
  );
}
