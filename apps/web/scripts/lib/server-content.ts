import type { ContentSources } from "@wenshan/content/node";

/** 只在服务端使用的内容（各主题的报告要求、边界例子与示范）：build-server-content 写出，发布验收比对 */
export function serverContentJson(src: ContentSources): string {
  const sampleOf = (id: string) => src.samples.find((s) => s.topic === id);
  const out = {
    contentVersion: src.version,
    topics: Object.fromEntries(
      src.topics.map((t) => {
        const s = sampleOf(t.id);
        return [
          t.id,
          {
            id: t.id,
            name: t.name,
            version: t.version,
            reviewStatus: t.reviewStatus,
            report: t.report,
            boundaryExamples: t.boundaryExamples,
            // 示范取自内容仓库的样例（samples/*.yaml）：完整报告样例，或同一卦在本主题下的"下一步"
            example: s ? { question: s.question, paid: s.paid ?? null, nextStep: s.nextStep ?? null } : null,
          },
        ];
      }),
    ),
  };
  return `${JSON.stringify(out, null, 1)}\n`;
}
