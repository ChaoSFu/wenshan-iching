"use client";

/**
 * 埋点入口（技术方案 5.13）。付费闭环上线前只在开发环境打印，不发送任何数据。
 * 任何事件都不得携带问题文本。
 */
export type EventName =
  | "entry_click"
  | "ask_submitted"
  | "cast_started"
  | "cast_completed"
  | "result_viewed"
  | "sample_viewed"
  | "unlock_clicked";

export function track(name: EventName, props: Record<string, string | number | boolean | null> = {}): void {
  if (process.env.NODE_ENV === "development") {
    console.debug("[track]", name, props);
  }
}
