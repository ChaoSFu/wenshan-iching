import { requireCapability } from "./capabilities";
import { env } from "./env";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
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
      headers: { Authorization: `Bearer ${env().RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env().MAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text }),
    });
    if (!res.ok) {
      // Resend 的错误说明（如发件域名未验证），不含收件人与正文
      const detail = (await res.json().catch(() => null)) as { message?: string } | null;
      throw new Error(`mail send failed: HTTP ${res.status} ${detail?.message ?? ""}`.trim());
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
