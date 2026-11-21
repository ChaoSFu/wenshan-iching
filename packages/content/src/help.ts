import type { HelpResources } from "./types";

export interface VisibleHelpItem {
  label: string;
  number?: string;
  /** 只在开发与测试环境出现：号码尚未人工核实 */
  unverified: boolean;
}

export interface VisibleHelp {
  intro: string;
  regions: { id: string; name: string; items: VisibleHelpItem[] }[];
  /** 因未核实而隐藏的号码条数 */
  hidden: number;
}

/**
 * 按审核状态决定公开页面与危机面板展示哪些求助号码。
 * - 正式环境（includeUnverified=false）：只展示已核实的号码；不带号码的通用指引照常展示；
 * - 开发与测试：全部展示，未核实的标出来，方便核对。
 * 号码错了会耽误求助，宁可只给"请拨打当地紧急电话"的通用指引。
 */
export function visibleHelp(help: HelpResources, opts: { includeUnverified: boolean }): VisibleHelp {
  let hidden = 0;
  const regions = help.regions
    .map((r) => ({
      id: r.id,
      name: r.name,
      items: r.items.flatMap((i): VisibleHelpItem[] => {
        const unverified = Boolean(i.number) && i.reviewStatus !== "reviewed";
        if (unverified && !opts.includeUnverified) {
          hidden++;
          return [];
        }
        return [{ label: i.label, number: i.number, unverified }];
      }),
    }))
    .filter((r) => r.items.length > 0);
  return { intro: help.intro, regions, hidden };
}
