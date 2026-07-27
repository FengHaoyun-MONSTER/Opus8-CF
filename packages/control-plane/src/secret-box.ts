const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(value: string): Uint8Array {
  let normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4) normalized += "=";
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function importKey(
  secret: string,
  usage: Array<"encrypt" | "decrypt">,
): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error("落地配置加密密钥未配置或长度不足");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, usage);
}

export async function sealJson(
  secret: string,
  value: unknown,
  additionalData: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(secret, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(additionalData) },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return `v1.${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ciphertext))}`;
}

export async function openJson<T>(
  secret: string,
  envelope: string,
  additionalData: string,
): Promise<T> {
  const [version, ivPart, cipherPart] = String(envelope || "").split(".");
  if (version !== "v1" || !ivPart || !cipherPart) throw new Error("无效的加密配置格式");
  const key = await importKey(secret, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: b64urlDecode(ivPart),
      additionalData: encoder.encode(additionalData),
    },
    key,
    b64urlDecode(cipherPart),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}
