import { CAPABILITIES, CAPABILITY_LABEL, capabilityGaps, env, type Capability, type Env } from "./env";
import { HttpError } from "./http";

/**
 * 按能力校验配置（第二轮 P0-4）：
 * - database：工单、登录、订单都要用；生产必须是 PostgreSQL + 字段加密密钥（不允许落到 PGlite）；
 * - payments / llm / mail：生产只允许真实服务，没配置就是"不可用"，绝不退回替身。
 *
 * 关闭收款的生产环境只需要用到的能力：免费起卦在浏览器里完成，工单只要数据库，
 * 工单通知再单独要求邮件。开放收款时 env() 在启动时要求全部就绪。
 * 已付款订单的履约与退款在执行前各自检查所需能力，缺配置时任务延后、不消耗重试次数。
 */
export { CAPABILITIES, CAPABILITY_LABEL, capabilityGaps, type Capability } from "./env";

export function hasCapability(cap: Capability, e: Env = env()): boolean {
  return capabilityGaps(e)[cap].length === 0;
}

/** 某项能力未配置：接口返回 503，后台任务延后重试（不计入失败次数） */
export class CapabilityUnavailableError extends HttpError {
  constructor(
    readonly capability: Capability,
    readonly missing: string[],
  ) {
    super(503, "service_unavailable", `${CAPABILITY_LABEL[capability]}服务暂时不可用`, { capability });
    this.name = "CapabilityUnavailableError";
  }
}

export function requireCapability(cap: Capability, e: Env = env()): void {
  const missing = capabilityGaps(e)[cap];
  if (missing.length) throw new CapabilityUnavailableError(cap, missing);
}

/** 开放收款需要的全部能力；返回缺少的配置 */
export function salesGaps(e: Env = env()): string[] {
  const g = capabilityGaps(e);
  return CAPABILITIES.flatMap((c) => g[c]);
}
