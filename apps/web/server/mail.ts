import { requireCapability } from "./capabilities";
import { env } from "./env";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /**
   * 邮件服务的幂等键（Resend：Idempotency-Key，24 小时内同一键只发一封）。
   * 交付与工单通知用稳定的键：响应丢失后重发不会让用户或运营收到两封。
   */
  idempotencyKey?: string;
}

/** 邮件服务明确拒绝（4xx，除并发冲突与限流外）：重试也不会成功 */
export class MailRejectedError extends Error {
  override name = "MailRejectedError";
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/** 开发环境：把邮件打印到服务端控制台（验证码在这里看） */
const consoleMailer: Mailer = {
  async send(msg) {
    console.info(`\n[mail] to=${msg.to}\n[mail] subject=${msg.subject}\n${msg.text}\n`);
  },
};

const resendMailer: Mailer = {
  async send(msg) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env().RESEND_API_KEY}`,
        "Content-Type": "application/json",
        ...(msg.idempotencyKey ? { "Idempotency-Key": msg.idempotencyKey } : {}),
      },
      body: JSON.stringify({ from: env().MAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text }),
    });
    if (!res.ok) {
      // Resend 的错误说明（如发件域名未验证），不含收件人与正文
      const detail = (await res.json().catch(() => null)) as { message?: string; name?: string } | null;
      const text = `mail send failed: HTTP ${res.status} ${detail?.name ?? ""} ${detail?.message ?? ""}`.replace(/\s+/g, " ").trim();
      // 409 concurrent_idempotent_requests（同一键仍在处理）与 429、5xx 可以重试；其余 4xx 不会自行好转
      if (res.status >= 400 && res.status < 500 && res.status !== 409 && res.status !== 429) throw new MailRejectedError(text);
      throw new Error(text);
    }
  },
};

let override: Mailer | null = null;

export function getMailer(): Mailer {
  if (override) return override;
  // 生产环境没配 Resend 时不可用（登录验证码、交付通知、工单通知各自处理），绝不只打印到控制台
  requireCapability("mail");
  return env().MAIL_PROVIDER === "resend" ? resendMailer : consoleMailer;
}

export function __setMailerForTests(m: Mailer | null): void {
  override = m;
}
