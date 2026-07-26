/**
 * Opus8-CF · 零依赖加密工具（WebCrypto，Workers 与 Node20 通用）
 * 提供 HMAC-SHA256 签名/校验、HS256 JWT、随机 id/token/uuid。
 */

const enc = new TextEncoder();

export function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64urlEncode(data: ArrayBuffer | string): string {
  const bytes = typeof data === "string" ? enc.encode(data) : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToString(s: string): string {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
}

/** 恒定时间比较，避免时序侧信道。 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** 返回 HMAC-SHA256 的十六进制签名。 */
export async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return toHex(sig);
}

export async function hmacVerify(secret: string, message: string, sigHex: string): Promise<boolean> {
  const expected = await hmacSign(secret, message);
  return timingSafeEqual(expected, sigHex.toLowerCase());
}

/** 最小 HS256 JWT 签发。expSeconds 为有效期（秒）。 */
export async function jwtSign(
  payload: Record<string, unknown>,
  secret: string,
  expSeconds = 86400,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expSeconds };
  const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = b64urlEncode(JSON.stringify(body));
  const data = `${header}.${claims}`;
  const sig = await hmacSign(secret, data);
  // 把 hex 签名转回 base64url
  const sigBytes = new Uint8Array(sig.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  return `${data}.${b64urlEncode(sigBytes.buffer)}`;
}

/** 校验 HS256 JWT，成功返回 payload，失败/过期返回 null。 */
export async function jwtVerify(
  token: string,
  secret: string,
): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, claims, sig] = parts;
  const expectedHex = await hmacSign(secret, `${header}.${claims}`);
  const expectedBytes = new Uint8Array(expectedHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const expectedB64 = b64urlEncode(expectedBytes.buffer);
  if (!timingSafeEqual(expectedB64, sig)) return null;
  try {
    const payload = JSON.parse(b64urlToString(claims)) as Record<string, unknown>;
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function randomHex(bytes = 16): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomUuid(): string {
  return crypto.randomUUID();
}

/** 订阅 token：足够长的 URL 安全随机串。 */
export function randomToken(): string {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return b64urlEncode(arr.buffer);
}
