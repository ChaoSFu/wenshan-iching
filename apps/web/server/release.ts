import { reviewSummary, type ReviewSummary } from "@wenshan/content";
import { CAPABILITIES, CAPABILITY_LABEL, capabilityGaps, type Capability } from "./capabilities";
import { corpus, topicsBundle } from "./content";
import type { Env } from "./env";

/**
 * 发布验收（第二轮 P0-4）：同一套检查给 npm run release:check 和运营后台用。
 * 分两个发布目标评估：
 * - free：关闭收款，只提供免费起卦与支持入口；
 * - sales：开放收款。内容严格审核、求助号码核实、支付/模型/邮件配置都必须通过。
 * 严格审核没通过时，结果明确显示"开放收款：不可发布"及原因，而不是让构建失败。
 */

export type CheckLevel = "pass" | "warn" | "fail";
export interface ReleaseCheck {
  id: string;
  label: string;
  detail: string;
  free: CheckLevel;
  sales: CheckLevel;
}

export interface ReleaseStatus {
  environment: Env["NODE_ENV"];
  salesEnabled: boolean;
  checks: ReleaseCheck[];
  review: ReviewSummary;
  freeReady: boolean;
  salesReady: boolean;
  /** 当前配置（SALES_ENABLED）对应的目标是否可发布 */
  currentReady: boolean;
}

const pass = (id: string, label: string, detail: string): ReleaseCheck => ({ id, label, detail, free: "pass", sales: "pass" });

export function releaseStatus(e: Env, configError?: string): ReleaseStatus {
  const checks: ReleaseCheck[] = [];
  if (configError) checks.push({ id: "config", label: "配置解析", detail: configError, free: "fail", sales: "fail" });

  const gaps = capabilityGaps(e);
  const needForFree: Partial<Record<Capability, true>> = { database: true };
  for (const c of CAPABILITIES) {
    const missing = gaps[c];
    if (!missing.length) checks.push(pass(`capability.${c}`, `${CAPABILITY_LABEL[c]}配置`, "已就绪"));
    else {
      checks.push({
        id: `capability.${c}`,
        label: `${CAPABILITY_LABEL[c]}配置`,
        detail: `缺少 ${missing.join(", ")}`,
        free: needForFree[c] ? "fail" : "warn",
        sales: "fail",
      });
    }
  }

  if (e.RUN_MODE === "simulation" || e.ALLOW_UNREVIEWED_CONTENT) {
    checks.push({ id: "test-config", label: "测试配置", detail: "RUN_MODE=simulation 或 ALLOW_UNREVIEWED_CONTENT 不能用于发布", free: "fail", sales: "fail" });
  }

  checks.push(
    e.SUPPORT_EMAIL
      ? pass("support.email", "公开客服邮箱", "已设置 SUPPORT_EMAIL")
      : { id: "support.email", label: "公开客服邮箱", detail: "未设置 SUPPORT_EMAIL：网站故障时用户没有备用联系方式", free: "warn", sales: "warn" },
  );
  const notifyOk = Boolean(e.SUPPORT_NOTIFY_EMAIL) && gaps.mail.length === 0;
  checks.push(
    notifyOk
      ? pass("support.notify", "工单通知", "新工单会通知运营邮箱")
      : {
          id: "support.notify",
          label: "工单通知",
          detail: e.SUPPORT_NOTIFY_EMAIL ? "邮件服务不可用，工单通知会延后" : "未设置 SUPPORT_NOTIFY_EMAIL：工单只在后台列表里看",
          free: "warn",
          sales: "warn",
        },
  );
  checks.push(
    e.OPS_EMAILS.trim()
      ? pass("ops", "运营后台", "已设置 OPS_EMAILS")
      : { id: "ops", label: "运营后台", detail: "未设置 OPS_EMAILS：没有人能处理工单与退款异常", free: "warn", sales: "fail" },
  );

  const review = reviewSummary(corpus, topicsBundle);
  const draftTopics = review.topics.filter((t) => t.reviewStatus !== "reviewed").map((t) => t.id);
  const contentDetail = `原文已审 ${review.originalsReviewed}/${review.required}，白话已审 ${review.vernacularReviewed}/${review.required}${
    draftTopics.length ? `，未审主题 ${draftTopics.join(", ")}` : ""
  }`;
  checks.push(
    review.allReviewed
      ? pass("content.review", "内容严格审核", contentDetail)
      : { id: "content.review", label: "内容严格审核", detail: contentDetail, free: "warn", sales: "fail" },
  );
  checks.push(
    review.helpUnverified.length === 0
      ? pass("content.help", "求助号码核实", "全部已核实")
      : {
          id: "content.help",
          label: "求助号码核实",
          detail: `${review.helpUnverified.length} 个号码未核实，正式环境不展示，危机面板只给通用指引`,
          free: "warn",
          sales: "fail",
        },
  );

  const freeReady = checks.every((c) => c.free !== "fail");
  const salesReady = checks.every((c) => c.sales !== "fail");
  return {
    environment: e.NODE_ENV,
    salesEnabled: e.SALES_ENABLED,
    checks,
    review,
    freeReady,
    salesReady,
    currentReady: e.SALES_ENABLED ? salesReady : freeReady,
  };
}
