import { NextResponse } from "next/server";
import type { z } from "zod";
import { env } from "./env";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly details?: unknown,
  ) {
    super(message ?? code);
  }
}

export function json(data: unknown, init?: number | ResponseInit): NextResponse {
  return NextResponse.json(data, typeof init === "number" ? { status: init } : init);
}

/** 写操作只接受同源请求（SameSite cookie 之外的第二道 CSRF 防线） */
export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new HttpError(403, "cross_site");
  if (origin && origin !== new URL(env().APP_URL).origin && origin !== new URL(req.url).origin && !devHostMatches(req, origin)) {
    throw new HttpError(403, "bad_origin");
  }
}

/**
 * 只在开发环境：Origin 与请求的 Host 一致也算同源（用 127.0.0.1 与 localhost 并行打开时，
 * Next 开发服务器给的 req.url 总是 localhost）。生产环境只认 APP_URL。
 */
function devHostMatches(req: Request, origin: string): boolean {
  if (env().NODE_ENV === "production") return false;
  const host = req.headers.get("host");
  return Boolean(host) && origin === `http://${host}`;
}

export async function readBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "invalid_body", parsed.error.issues.map((i) => i.message).join("; "));
  return parsed.data;
}

/** 统一的错误处理：日志里只记错误码，不记请求体（技术方案 8.2） */
export function handle(fn: (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>) {
  return async (req: Request, ctx: { params: Promise<Record<string, string>> }): Promise<Response> => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.code, message: err.message, details: err.details }, err.status);
      console.error(`[api] ${req.method} ${new URL(req.url).pathname} failed:`, err instanceof Error ? err.message : err);
      return json({ error: "internal" }, 500);
    }
  };
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}
