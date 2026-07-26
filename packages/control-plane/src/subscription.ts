import type { NodeRecord, UserRecord, SubFormat } from "@opus8-cf/shared";

const DEFAULT_PATH = "/?ed=2560";
const MAX_IPS_PER_NODE = 3;

function nodeName(n: NodeRecord): string {
  return `Opus8-${n.region || n.account_alias}-${n.id.slice(0, 6)}`;
}

/** 选出分配给该用户的节点（node_group 为空=全部启用且健康）。 */
export function nodesForUser(user: UserRecord, all: NodeRecord[]): NodeRecord[] {
  const healthy = all.filter((n) => n.enabled === 1 && n.health !== "banned");
  let group: string[] = [];
  try {
    group = user.node_group ? (JSON.parse(user.node_group) as string[]) : [];
  } catch {
    group = [];
  }
  if (group.length === 0) return healthy;
  return healthy.filter((n) => group.includes(n.account_alias) || group.includes(n.id));
}

interface Entry {
  node: NodeRecord;
  address: string; // 连接地址：优选IP 或 节点域名
  name: string;
}

/** 把节点展开成订阅条目：有优选IP时每节点多条(不同IP)，否则每节点一条。 */
function expand(nodes: NodeRecord[], optIps: string[]): Entry[] {
  const ips = (optIps || []).slice(0, MAX_IPS_PER_NODE);
  const entries: Entry[] = [];
  for (const n of nodes) {
    if (ips.length) {
      ips.forEach((ip, i) => entries.push({ node: n, address: ip, name: `${nodeName(n)}-ip${i + 1}` }));
    } else {
      entries.push({ node: n, address: n.preferred_ip || n.hostname, name: nodeName(n) });
    }
  }
  return entries;
}

function vlessLink(uuid: string, e: Entry): string {
  const host = e.node.hostname;
  const q = new URLSearchParams({
    encryption: "none",
    security: "tls",
    sni: host,
    fp: "chrome",
    type: "ws",
    host,
    path: DEFAULT_PATH,
  });
  return `vless://${uuid}@${e.address}:443?${q.toString()}#${encodeURIComponent(e.name)}`;
}

function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function buildBase64(user: UserRecord, entries: Entry[]): string {
  return utf8ToBase64(entries.map((e) => vlessLink(user.uuid, e)).join("\n"));
}

export function buildClash(user: UserRecord, entries: Entry[]): string {
  const names: string[] = [];
  const proxies = entries.map((e) => {
    names.push(e.name);
    return [
      `  - name: "${e.name}"`,
      `    type: vless`,
      `    server: ${e.address}`,
      `    port: 443`,
      `    uuid: ${user.uuid}`,
      `    network: ws`,
      `    tls: true`,
      `    udp: true`,
      `    servername: ${e.node.hostname}`,
      `    client-fingerprint: chrome`,
      `    ws-opts:`,
      `      path: "${DEFAULT_PATH}"`,
      `      headers:`,
      `        Host: ${e.node.hostname}`,
    ].join("\n");
  });
  const nameList = names.map((n) => `      - "${n}"`).join("\n");
  return [
    `# Opus8-CF 订阅（Clash/Mihomo）`,
    `proxies:`,
    proxies.join("\n"),
    `proxy-groups:`,
    `  - name: Opus8`,
    `    type: select`,
    `    proxies:`,
    nameList,
    `rules:`,
    `  - MATCH,Opus8`,
    ``,
  ].join("\n");
}

export function buildSingbox(user: UserRecord, entries: Entry[]): string {
  const outbounds = entries.map((e) => ({
    type: "vless",
    tag: e.name,
    server: e.address,
    server_port: 443,
    uuid: user.uuid,
    tls: { enabled: true, server_name: e.node.hostname, utls: { enabled: true, fingerprint: "chrome" } },
    transport: { type: "ws", path: DEFAULT_PATH, headers: { Host: e.node.hostname } },
  }));
  return JSON.stringify({ outbounds }, null, 2);
}

export function renderSubscription(
  format: SubFormat, user: UserRecord, nodes: NodeRecord[], optIps: string[] = [],
): { body: string; contentType: string } {
  const entries = expand(nodes, optIps);
  if (format === "clash")
    return { body: buildClash(user, entries), contentType: "text/yaml; charset=utf-8" };
  if (format === "singbox")
    return { body: buildSingbox(user, entries), contentType: "application/json; charset=utf-8" };
  return { body: buildBase64(user, entries), contentType: "text/plain; charset=utf-8" };
}

export function pickFormat(ua: string, override?: string | null): SubFormat {
  if (override === "clash" || override === "singbox" || override === "base64") return override;
  const u = ua.toLowerCase();
  if (u.includes("clash") || u.includes("mihomo") || u.includes("stash")) return "clash";
  if (u.includes("sing-box") || u.includes("singbox")) return "singbox";
  return "base64";
}
