import { connect } from "cloudflare:sockets";
import { randomHex } from "@opus8-cf/shared";
import type { Env } from "./db";
import { openJson, sealJson } from "./secret-box";
import { validateUnlockHosts } from "./routing";

interface LandingRow {
  id: string;
  name: string;
  hostname: string;
  port: number;
  credential_enc: string;
  region: string | null;
  match_hosts: string;
  priority: number;
  enabled: number;
  health: "healthy" | "unhealthy" | "unknown";
  last_checked: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface LandingCredential {
  username: string;
  password: string;
}

export interface LandingInput {
  name?: unknown;
  hostname?: unknown;
  port?: unknown;
  username?: unknown;
  password?: unknown;
  region?: unknown;
  matchHosts?: unknown;
  priority?: unknown;
  enabled?: unknown;
}

export interface PublicLanding {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  passwordConfigured: true;
  region: string | null;
  matchHosts: string[];
  priority: number;
  enabled: boolean;
  health: LandingRow["health"];
  lastChecked: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeLanding {
  id: string;
  hostname: string;
  port: number;
  username: string;
  password: string;
  matchHosts: string[];
  priority: number;
}

function normalizeHostname(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase();
  if (!host || host.length > 253 || /[/?#@\s]/.test(host)) return null;
  try {
    const bareIpv6 = host.includes(":") && !host.startsWith("[");
    const parsed = new URL(`http://${bareIpv6 ? `[${host}]` : host}`);
    if (parsed.port) return null;
    return parsed.hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

function parseMatchHosts(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return validateUnlockHosts(parsed).hosts;
  } catch {
    return [];
  }
}

function requireText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${label}长度不能超过 ${maxLength}`);
  return normalized;
}

function requireCredentialPart(value: unknown, label: string): string {
  const normalized = requireText(value, label, 255);
  if (new TextEncoder().encode(normalized).length > 255) throw new Error(`${label}不能超过 255 字节`);
  return normalized;
}

function validateCommon(input: LandingInput, partial: boolean): {
  name?: string;
  hostname?: string;
  port?: number;
  region?: string | null;
  matchHosts?: string[];
  priority?: number;
  enabled?: boolean;
} {
  const out: {
    name?: string; hostname?: string; port?: number; region?: string | null;
    matchHosts?: string[]; priority?: number; enabled?: boolean;
  } = {};
  if (!partial || input.name !== undefined) out.name = requireText(input.name, "名称", 64);
  if (!partial || input.hostname !== undefined) {
    const hostname = normalizeHostname(input.hostname);
    if (!hostname) throw new Error("落地机地址无效");
    out.hostname = hostname;
  }
  if (!partial || input.port !== undefined) {
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口必须是 1-65535");
    out.port = port;
  }
  if (!partial || input.region !== undefined) {
    if (input.region === null || input.region === "") out.region = null;
    else out.region = requireText(input.region, "地区", 32);
  }
  if (!partial || input.matchHosts !== undefined) {
    const validated = validateUnlockHosts(input.matchHosts ?? []);
    if (validated.invalidHosts.length > 0) {
      throw new Error(`存在无效负责域名: ${validated.invalidHosts.slice(0, 5).join(", ")}`);
    }
    out.matchHosts = validated.hosts;
  }
  if (!partial || input.priority !== undefined) {
    const priority = Number(input.priority ?? 100);
    if (!Number.isInteger(priority) || priority < 1 || priority > 1000) {
      throw new Error("优先级必须是 1-1000");
    }
    out.priority = priority;
  }
  if (!partial || input.enabled !== undefined) {
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
    out.enabled = input.enabled !== false;
  }
  return out;
}

async function credentialFor(env: Env, row: LandingRow): Promise<LandingCredential> {
  return openJson<LandingCredential>(
    env.LANDING_CONFIG_KEY,
    row.credential_enc,
    `landing:${row.id}`,
  );
}

async function rowToPublic(env: Env, row: LandingRow): Promise<PublicLanding> {
  const credential = await credentialFor(env, row);
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    port: row.port,
    username: credential.username,
    passwordConfigured: true,
    region: row.region,
    matchHosts: parseMatchHosts(row.match_hosts),
    priority: row.priority,
    enabled: row.enabled === 1,
    health: row.health,
    lastChecked: row.last_checked,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getRow(env: Env, id: string): Promise<LandingRow | null> {
  return env.DB.prepare("SELECT * FROM landings WHERE id=?1").bind(id).first<LandingRow>();
}

export async function listLandings(env: Env): Promise<PublicLanding[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM landings ORDER BY priority ASC, created_at ASC",
  ).all<LandingRow>();
  return Promise.all((results ?? []).map((row) => rowToPublic(env, row)));
}

export async function createLanding(env: Env, input: LandingInput): Promise<PublicLanding> {
  const common = validateCommon(input, false);
  const username = requireCredentialPart(input.username, "用户名");
  const password = requireCredentialPart(input.password, "密码");
  const id = randomHex(8);
  const now = Date.now();
  const encrypted = await sealJson(
    env.LANDING_CONFIG_KEY,
    { username, password },
    `landing:${id}`,
  );
  await env.DB.prepare(
    `INSERT INTO landings
      (id,name,hostname,port,credential_enc,region,match_hosts,priority,enabled,health,created_at,updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'unknown',?10,?10)`,
  ).bind(
    id, common.name, common.hostname, common.port, encrypted, common.region ?? null,
    JSON.stringify(common.matchHosts ?? []), common.priority ?? 100,
    common.enabled === false ? 0 : 1, now,
  ).run();
  return rowToPublic(env, (await getRow(env, id))!);
}

export async function updateLanding(
  env: Env,
  id: string,
  input: LandingInput,
): Promise<PublicLanding | null> {
  const row = await getRow(env, id);
  if (!row) return null;
  const common = validateCommon(input, true);
  const hasUsername = input.username !== undefined && input.username !== "";
  const hasPassword = input.password !== undefined && input.password !== "";
  if (hasUsername !== hasPassword) throw new Error("更新凭据时必须同时填写用户名和密码");
  let encrypted = row.credential_enc;
  if (hasUsername && hasPassword) {
    encrypted = await sealJson(
      env.LANDING_CONFIG_KEY,
      {
        username: requireCredentialPart(input.username, "用户名"),
        password: requireCredentialPart(input.password, "密码"),
      },
      `landing:${id}`,
    );
  }
  const connectionChanged =
    common.hostname !== undefined ||
    common.port !== undefined ||
    (hasUsername && hasPassword);
  await env.DB.prepare(
    `UPDATE landings SET
      name=?2,hostname=?3,port=?4,credential_enc=?5,region=?6,match_hosts=?7,
      priority=?8,enabled=?9,updated_at=?10,
      health=CASE WHEN ?11=1 THEN 'unknown' ELSE health END,
      last_checked=CASE WHEN ?11=1 THEN NULL ELSE last_checked END,
      last_error=CASE WHEN ?11=1 THEN NULL ELSE last_error END
     WHERE id=?1`,
  ).bind(
    id,
    common.name ?? row.name,
    common.hostname ?? row.hostname,
    common.port ?? row.port,
    encrypted,
    common.region === undefined ? row.region : common.region,
    common.matchHosts === undefined ? row.match_hosts : JSON.stringify(common.matchHosts),
    common.priority ?? row.priority,
    common.enabled === undefined ? row.enabled : (common.enabled ? 1 : 0),
    Date.now(),
    connectionChanged ? 1 : 0,
  ).run();
  return rowToPublic(env, (await getRow(env, id))!);
}

export async function deleteLanding(env: Env, id: string): Promise<boolean> {
  const existing = await getRow(env, id);
  if (!existing) return false;
  await env.DB.prepare("DELETE FROM landings WHERE id=?1").bind(id).run();
  return true;
}

export async function runtimeLandings(env: Env): Promise<RuntimeLanding[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM landings WHERE enabled=1 ORDER BY priority ASC, created_at ASC",
  ).all<LandingRow>();
  const output: RuntimeLanding[] = [];
  for (const row of results ?? []) {
    try {
      const credential = await credentialFor(env, row);
      output.push({
        id: row.id,
        hostname: row.hostname,
        port: row.port,
        username: credential.username,
        password: credential.password,
        matchHosts: parseMatchHosts(row.match_hosts),
        priority: row.priority,
      });
    } catch {
      // 单条损坏配置不应阻断全部节点策略。
    }
  }
  return output;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("连接超时")), timeoutMs)),
  ]);
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array> {
  const result = await withTimeout(reader.read(), 8_000);
  if (result.done || !result.value) throw new Error("代理提前关闭连接");
  return result.value;
}

async function readAtLeast(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  minimum: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length < minimum) {
    const chunk = await readChunk(reader);
    chunks.push(chunk);
    length += chunk.length;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

async function readConnectReply(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Uint8Array> {
  let response = await readAtLeast(reader, 5);
  let required = 0;
  if (response[3] === 0x01) required = 10;
  else if (response[3] === 0x04) required = 22;
  else if (response[3] === 0x03) required = 7 + response[4];
  else throw new Error(`SOCKS5 返回了未知地址类型 ${response[3]}`);
  if (response.length >= required) return response;
  const remainder = await readAtLeast(reader, required - response.length);
  const combined = new Uint8Array(response.length + remainder.length);
  combined.set(response);
  combined.set(remainder, response.length);
  response = combined;
  return response;
}

async function probeSocks5(row: LandingRow, credential: LandingCredential): Promise<void> {
  const socket = connect({ hostname: row.hostname, port: row.port });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  try {
    await withTimeout(socket.opened, 8_000);
    await writer.write(new Uint8Array([0x05, 0x02, 0x00, 0x02]));
    let response = await readAtLeast(reader, 2);
    const method = response[1];
    if (method === 0x02) {
      const user = new TextEncoder().encode(credential.username);
      const password = new TextEncoder().encode(credential.password);
      await writer.write(new Uint8Array([0x01, user.length, ...user, password.length, ...password]));
      response = await readAtLeast(reader, 2);
      if (response[1] !== 0x00) throw new Error("SOCKS5 用户名或密码错误");
    } else if (method !== 0x00) {
      throw new Error(`SOCKS5 不支持认证方式 ${method}`);
    }
    const target = new TextEncoder().encode("example.com");
    await writer.write(new Uint8Array([0x05, 0x01, 0x00, 0x03, target.length, ...target, 0x00, 0x50]));
    response = await readConnectReply(reader);
    if (response[1] !== 0x00) throw new Error(`SOCKS5 出站连接失败，代码 ${response[1]}`);
    await writer.write(new TextEncoder().encode(
      "HEAD / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n",
    ));
    const http = new TextDecoder().decode(await readAtLeast(reader, 12));
    if (!/^HTTP\/1\.[01] [23]\d\d/m.test(http)) throw new Error("落地出口未返回有效 HTTP 响应");
  } finally {
    try { writer.releaseLock(); } catch { /* ignore */ }
    try { reader.releaseLock(); } catch { /* ignore */ }
    try { socket.close(); } catch { /* ignore */ }
  }
}

export async function testLanding(
  env: Env,
  id: string,
): Promise<{ ok: boolean; latencyMs: number; error?: string } | null> {
  const row = await getRow(env, id);
  if (!row) return null;
  const started = Date.now();
  try {
    await probeSocks5(row, await credentialFor(env, row));
    const latencyMs = Date.now() - started;
    await env.DB.prepare(
      "UPDATE landings SET health='healthy',last_checked=?2,last_error=NULL WHERE id=?1",
    ).bind(id, Date.now()).run();
    return { ok: true, latencyMs };
  } catch (error) {
    const message = (error as Error).message.slice(0, 240);
    await env.DB.prepare(
      "UPDATE landings SET health='unhealthy',last_checked=?2,last_error=?3 WHERE id=?1",
    ).bind(id, Date.now(), message).run();
    return { ok: false, latencyMs: Date.now() - started, error: message };
  }
}
