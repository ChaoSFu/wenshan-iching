import type { LlmProvider } from "./index";
import { costUsd } from "./usage";

/**
 * 显式预算（第三轮 P1，真实联调与真实评测用）：每次模型调用前检查已花费用，超出预算就停；
 * 价格表里没有的模型（成本未知）默认在第一次未知后就停，除非显式允许——未知成本不能按 0 计入预算。
 * 只包住生成调用；内容审核（moderation）不计费。
 */
export class BudgetExceededError extends Error {
  override name = "BudgetExceededError";
}

export interface BudgetSpend {
  calls: number;
  knownUsd: number;
  unknownCalls: number;
}

export function withBudget(llm: LlmProvider, opts: { budgetUsd: number; allowUnknownCost?: boolean }): LlmProvider & { spent(): BudgetSpend } {
  const spend: BudgetSpend = { calls: 0, knownUsd: 0, unknownCalls: 0 };
  return {
    name: llm.name,
    moderate: (texts) => llm.moderate(texts),
    async generateStructured(req) {
      if (spend.knownUsd >= opts.budgetUsd) throw new BudgetExceededError(`budget US$${opts.budgetUsd} reached (spent US$${spend.knownUsd.toFixed(4)})`);
      if (spend.unknownCalls > 0 && !opts.allowUnknownCost) {
        throw new BudgetExceededError(`a previous call had unknown cost; refusing to continue without --allow-unknown-cost`);
      }
      const r = await llm.generateStructured(req);
      spend.calls++;
      const c = costUsd(r.model, r.usage);
      if (c === null) spend.unknownCalls++;
      else spend.knownUsd += c;
      return r;
    },
    spent: () => ({ ...spend }),
  };
}
