import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env";

/**
 * 应用层字段加密（技术方案第 6 节）：AES-256-GCM，密文格式
 *   v1:<keyId>:<iv>:<tag>:<ciphertext>（均为 base64url）
 * keyId 便于以后轮换密钥。
 */

const KEY_ID = "k1";
let devWarned = false;

function masterKey(): Buffer {
  const configured = env().DATA_ENCRYPTION_KEY;
  if (configured) {
    const key = Buffer.from(configured, "base64");
    if (key.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must be 32 bytes (base64)");
    return key;
  }
  if (env().NODE_ENV === "production") throw new Error("DATA_ENCRYPTION_KEY is required in production");
  if (!devWarned && env().NODE_ENV !== "test") {
    console.warn("[crypto] DATA_ENCRYPTION_KEY not set — using an insecure development key");
    devWarned = true;
  }
  return createHash("sha256").update("wenshan-dev-only-key").digest();
}

/** 由主密钥派生的子密钥，不同用途互不相同 */
function subKey(purpose: string): Buffer {
  return createHmac("sha256", masterKey()).update(`wenshan:${purpose}`).digest();
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", subKey("field-encryption"), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", KEY_ID, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(":");
}

export function decrypt(payload: string): string {
  const [version, keyId, iv, tag, ct] = payload.split(":");
  if (version !== "v1" || keyId !== KEY_ID || !iv || !tag || ct === undefined) throw new Error("unsupported ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", subKey("field-encryption"), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

export function encryptJson(value: unknown): string {
  return encrypt(JSON.stringify(value));
}

export function decryptJson<T>(payload: string): T {
  return JSON.parse(decrypt(payload)) as T;
}

/** 带密钥的哈希（验证码、邮箱、IP 等不需要还原的值） */
export function keyedHash(purpose: string, value: string): string {
  return createHmac("sha256", subKey(`hash:${purpose}`)).update(value).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** 给模型服务方的不透明用户标识（safety_identifier），不含邮箱 */
export function safetyIdentifier(userId: string): string {
  return keyedHash("safety-identifier", userId).slice(0, 32);
}
