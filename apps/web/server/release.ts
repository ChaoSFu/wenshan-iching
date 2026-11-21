import { reviewSummary, type ReviewSummary } from "@wenshan/content";
import { LIVE_SERVICES, configVersion, latestEvidence, type LiveEvidence, type LiveService } from "./acceptance";
import { CAPABILITY_LABEL, capabilityGaps } from "./capabilities";
import { corpus, topicsBundle } from "./content";
import type { Env } from "./env";

/**
 * 发布验收（第二轮 P0-4，第三轮 P1 重构，附录 F.6）：同一套检查给 npm run release:check 和运营后台用。
 * 结果分三项给出——配置校验、内容审校、真实联调——并分两个发布目标评估：
 * - free：关闭收款，只提供免费起卦、运营入口与公开支持；
 * - sales：开放收款。严格审校（含源文件与生成文件一致）、求助号码核实、三项真实联调都必须通过。
 * 没通过时，结果明确写出"开放收款：不可发布"及每一项原因，而不是让构建失败。
 */

export type CheckLevel = "pass" | "warn" | "fail" | "na";
export type Section = "config" | "content" | "live";
export const SECTION_LABEL: Record<Section, string> = { config: "配置校验", content: "内容审校", live: "真实联调" };
export const RELEASE_TARGETS = ["free", "sales"] as const;
export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

export interface ReleaseCheck {
  id: string;
  section: Section;
  label: string;
  detail: string;
  free: CheckLevel;
  sales: CheckLevel;
}

/** 内容源文件的检查（只有 CLI 能读 packages/content 源文件）；运营后台里为空，表示需要在发布前跑 CLI */
export interface SourceChecks {
  /** 非严格校验的错误（结构、引用、缺失） */
  basicErrors: string[];
  /** 严格审校未通过的项 */
  strictErrors: string[];
  /** 与源文件不一致的生成文件 */
  stale: string[];
}

export interface SmokeResult {
  path: string;
  ok: boolean;
  detail: string;
}

export interface ReleaseInputs {
  configError?: string;
  sources?: SourceChecks | null;
  evidence?: LiveEvidence[];
  /** 对部署地址的免费体验冒烟检查（CLI --smoke-url） */
  smoke?: SmokeResult[] | null;
}

export interface ReleaseStatus {
  environment: Env["NODE_ENV"];
  salesEnabled: boolean;
  configVersion: string;
  checks: ReleaseCheck[];
  /** 每一项（配置校验 / 内容审校 / 真实联调）在两个目标下的结论 */
  sections: Record<Section, { free: CheckLevel; sales: CheckLevel }>;
  review: ReviewSummary;
  freeReady: boolean;
  salesReady: boolean;
  /** 当前配置（SALES_ENABLED）对应的目标是否可发布 */
  currentReady: boolean;
}

const RANK: Record<CheckLevel, number> = { na: 0, pass: 1, warn: 2, fail: 3 };
const worst = (levels: CheckLevel[]): CheckLevel => levels.reduce<CheckLevel>((w, l) => (RANK[l] > RANK[w] ? l : w), "na");

function c(section: Section, id: string, label: string, detail: string, free: CheckLevel, sales: CheckLevel): ReleaseCheck {
  return { id, section, label, detail, free, sales };
}

const SERVICE_LABEL: Record<LiveService, string> = { stripe: "Stripe 测试模式联调", openai: "OpenAI 合成样例联调", resend: "Resend 测试收件箱联调" };

export function releaseStatus(e: Env, inputs: ReleaseInputs = {}): ReleaseStatus {
  const checks: ReleaseCheck[] = [];
  const version = configVersion(e);

  // ---------------- 配置校验
  if (inputs.configError) checks.push(c("config", "config", "配置解析", inputs.configError, "fail", "fail"));
  const gaps = capabilityGaps(e);
  checks.push(
    gaps.database.length
      ? c("config", "capability.database", `${CAPABILITY_LABEL.database}配置`, `缺少 ${gaps.database.join(", ")}`, "fail", "fail")
      : c("config", "capability.database", `${CAPABILITY_LABEL.database}配置`, "已就绪", "pass", "pass"),
  );
  for (const cap of ["payments", "llm"] as const) {
    const missing = gaps[cap];
    // 关闭收款时不会用到支付与模型：缺了也不影响免费体验
    checks.push(c("config", `capability.${cap}`, `${CAPABILITY_LABEL[cap]}配置`, missing.length ? `缺少 ${missing.join(", ")}` : "已就绪", "na", missing.length ? "fail" : "pass"));
  }
  checks.push(
    c(
      "config",
      "capability.mail",
      `${CAPABILITY_LABEL.mail}配置`,
      gaps.mail.length ? `缺少 ${gaps.mail.join(", ")}（关闭收款时只影响登录验证码与工单通知）` : "已就绪",
      gaps.mail.length ? "warn" : "pass",
      gaps.mail.length ? "fail" : "pass",
    ),
  );
  checks.push(
    c(
      "config",
      "sales.switch",
      "收款开关",
      e.SALES_ENABLED ? "SALES_ENABLED=true（开放收款）" : "SALES_ENABLED=false（只提供免费体验）",
      e.SALES_ENABLED ? "fail" : "pass",
      e.SALES_ENABLED ? "pass" : "fail",
    ),
  );
  if (e.RUN_MODE === "simulation" || e.ALLOW_UNREVIEWED_CONTENT) {
    checks.push(c("config", "test-config", "测试配置", "RUN_MODE=simulation 或 ALLOW_UNREVIEWED_CONTENT 不能用于发布", "fail", "fail"));
  }
  // 运营入口与公开支持：免费发布也要单独验收（有工单就要有人处理，网站故障时用户要有联系方式）
  checks.push(
    e.OPS_EMAILS.trim()
      ? c("config", "ops", "运营入口", "已设置 OPS_EMAILS（/ops 后台）", "pass", "pass")
      : c("config", "ops", "运营入口", "未设置 OPS_EMAILS：没有人能处理工单与订单异常", "fail", "fail"),
  );
  checks.push(
    e.SUPPORT_EMAIL
      ? c("config", "support.email", "公开支持邮箱", "已设置 SUPPORT_EMAIL（网站故障时的备用联系方式）", "pass", "pass")
      : c("config", "support.email", "公开支持邮箱", "未设置 SUPPORT_EMAIL：网站故障时用户没有备用联系方式", "fail", "fail"),
  );
  const notifyOk = Boolean(e.SUPPORT_NOTIFY_EMAIL) && gaps.mail.length === 0;
  checks.push(
    notifyOk
      ? c("config", "support.notify", "工单通知", "新工单会通知运营邮箱", "pass", "pass")
      : c(
          "config",
          "support.notify",
          "工单通知",
          e.SUPPORT_NOTIFY_EMAIL ? "邮件服务不可用，工单通知会延后" : "未设置 SUPPORT_NOTIFY_EMAIL：工单只在后台列表里看",
          "warn",
          "warn",
        ),
  );

  // ---------------- 内容审校
  const review = reviewSummary(corpus, topicsBundle);
  const draftTopics = review.topics.filter((t) => t.reviewStatus !== "reviewed").map((t) => t.id);
  const contentDetail = `原文已审 ${review.originalsReviewed}/${review.required}，白话已审 ${review.vernacularReviewed}/${review.required}${
    draftTopics.length ? `，未审主题 ${draftTopics.join(", ")}` : ""
  }`;
  checks.push(c("content", "content.review", "内容审校（已发布的生成文件）", contentDetail, review.allReviewed ? "pass" : "warn", review.allReviewed ? "pass" : "fail"));
  checks.push(
    review.helpUnverified.length === 0
      ? c("content", "content.help", "求助号码核实", "全部已核实", "pass", "pass")
      : c("content", "content.help", "求助号码核实", `${review.helpUnverified.length} 个号码未核实，正式环境不展示，危机面板只给通用指引`, "warn", "fail"),
  );
  const src = inputs.sources;
  if (!src) {
    const detail = "需要读取内容源文件：发布前运行 npm run release:check";
    checks.push(c("content", "content.consistency", "源文件与生成文件一致", detail, "warn", "fail"));
    checks.push(c("content", "content.strict", "严格审校（源文件）", detail, "warn", "fail"));
  } else {
    checks.push(
      src.basicErrors.length
        ? c("content", "content.basic", "内容结构校验", `${src.basicErrors.length} 项错误，例如 ${src.basicErrors[0]}`, "fail", "fail")
        : c("content", "content.basic", "内容结构校验", "通过", "pass", "pass"),
    );
    checks.push(
      src.stale.length
        ? c("content", "content.consistency", "源文件与生成文件一致", `generated/ 与源文件不一致：${src.stale.join(", ")}（运行 npm run content:build 后提交）`, "fail", "fail")
        : c("content", "content.consistency", "源文件与生成文件一致", "一致", "pass", "pass"),
    );
    checks.push(
      src.strictErrors.length
        ? c("content", "content.strict", "严格审校（源文件）", `${src.strictErrors.length} 项未通过`, "warn", "fail")
        : c("content", "content.strict", "严格审校（源文件）", "通过", "pass", "pass"),
    );
  }

  // ---------------- 真实联调
  const latest = latestEvidence(inputs.evidence ?? []);
  for (const s of LIVE_SERVICES) {
    const ev = latest[s];
    const id = `live.${s}`;
    if (!ev) {
      checks.push(c("live", id, SERVICE_LABEL[s], "没有联调记录（npm run acceptance -- --service=" + s + "）", "na", "fail"));
      continue;
    }
    const where = `${ev.recordedAt.slice(0, 10)} · 提交 ${ev.commit.slice(0, 8)}${ev.dirty ? "（含未提交改动）" : ""} · ${ev.environment}`;
    const failed = ev.checks.filter((x) => !x.ok).map((x) => x.name);
    if (ev.result !== "pass" || failed.length) {
      checks.push(c("live", id, SERVICE_LABEL[s], `${where}：未通过 ${failed.join("、") || ev.result}`, "na", "fail"));
    } else if (ev.pending.length) {
      checks.push(c("live", id, SERVICE_LABEL[s], `${where}：待核实 ${ev.pending.join("；")}`, "na", "fail"));
    } else if (ev.configVersion !== configVersion(e, s)) {
      checks.push(c("live", id, SERVICE_LABEL[s], `${where}：联调后配置已改动（联调时 ${ev.configVersion}，当前 ${configVersion(e, s)}），需要重新联调`, "na", "fail"));
    } else if (ev.dirty) {
      checks.push(c("live", id, SERVICE_LABEL[s], `${where}：联调时工作树有未提交改动，请在干净的提交上重跑`, "na", "fail"));
    } else {
      checks.push(c("live", id, SERVICE_LABEL[s], `${where}：通过`, "na", "pass"));
    }
  }
  if (inputs.smoke) {
    const bad = inputs.smoke.filter((x) => !x.ok);
    checks.push(
      c(
        "live",
        "live.smoke",
        "部署地址冒烟检查",
        bad.length ? bad.map((x) => `${x.path}：${x.detail}`).join("；") : inputs.smoke.map((x) => x.path).join("、") + " 均正常",
        bad.length ? "fail" : "pass",
        bad.length ? "fail" : "pass",
      ),
    );
  } else {
    checks.push(c("live", "live.smoke", "部署地址冒烟检查", "未检查（npm run release:check -- --smoke-url=<部署地址>）", "warn", "warn"));
  }

  const sections = {} as ReleaseStatus["sections"];
  for (const s of ["config", "content", "live"] as const) {
    const of = checks.filter((x) => x.section === s);
    sections[s] = { free: worst(of.map((x) => x.free)), sales: worst(of.map((x) => x.sales)) };
  }
  const freeReady = checks.every((x) => x.free !== "fail");
  const salesReady = checks.every((x) => x.sales !== "fail");
  return {
    environment: e.NODE_ENV,
    salesEnabled: e.SALES_ENABLED,
    configVersion: version,
    checks,
    sections,
    review,
    freeReady,
    salesReady,
    currentReady: e.SALES_ENABLED ? salesReady : freeReady,
  };
}

/** 免费体验的冒烟检查：首页、求助页、支持页可以打开；报价接口显示收款状态与目标一致 */
export async function smokeCheck(baseUrl: string, target: ReleaseTarget): Promise<SmokeResult[]> {
  const out: SmokeResult[] = [];
  for (const p of ["/", "/help", "/support"]) {
    try {
      const res = await fetch(new URL(p, baseUrl), { redirect: "manual" });
      out.push({ path: p, ok: res.status === 200, detail: `HTTP ${res.status}` });
    } catch (err) {
      out.push({ path: p, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  try {
    const res = await fetch(new URL("/api/offer", baseUrl));
    const body = (await res.json()) as { salesEnabled?: boolean };
    const expected = target === "sales";
    out.push({ path: "/api/offer", ok: res.ok && body.salesEnabled === expected, detail: `HTTP ${res.status}，salesEnabled=${String(body.salesEnabled)}（期望 ${expected}）` });
  } catch (err) {
    out.push({ path: "/api/offer", ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
  return out;
}
