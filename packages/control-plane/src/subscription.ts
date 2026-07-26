import type { NodeRecord, UserRecord, SubFormat } from "@opus8-cf/shared";

const DEFAULT_PATH = "/?ed=2560";

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

function vlessLink(uuid: string, n: NodeRecord): string {
  const address = n.preferred_ip || n.hostname;
  const host = n.hostname;
  const q = new URLSearchParams({
    encryption: "none",
    security: "tls",
    sni: host,
    fp: "chrome",
    type: "ws",
    host,
    path: DEFAULT_PATH,
  });
  return `vless://${uuid}@${address}:443?${q.toString()}#${encodeURIComponent(nodeName(n))}`;
}

function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function buildBase64(user: UserRecord, nodes: NodeRecord[]): string {
  const links = nodes.map((n) => vlessLink(user.uuid, n)).join("\n");
  return utf8ToBase64(links);
}

export function buildClash(user: UserRecord, nodes: NodeRecord[]): string {
  const names: string[] = [];
  const proxies = nodes.map((n) => {
    const name = nodeName(n);
    names.push(name);
    const server = n.preferred_ip || n.hostname;
    return [
      `  - name: "${name}"`,
      `    type: vless`,
      `    server: ${server}`,
      `    port: 443`,
      `    uuid: ${user.uuid}`,
      `    network: ws`,
      `    tls: true`,
      `    udp: true`,
      `    servername: ${n.hostname}`,
      `    client-fingerprint: chrome`,
      `    ws-opts:`,
      `      path: "${DEFAULT_PATH}"`,
      `      headers:`,
      `        Host: ${n.hostname}`,
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

export function buildSingbox(user: UserRecord, nodes: NodeRecord[]): string {
  const outbounds = nodes.map((n) => ({
    type: "vless",
    tag: nodeName(n),
    server: n.preferred_ip || n.hostname,
    server_port: 443,
    uuid: user.uuid,
    tls: { enabled: true, server_name: n.hostname, utls: { enabled: true, fingerprint: "chrome" } },
    transport: { type: "ws", path: DEFAULT_PATH, headers: { Host: n.hostname } },
  }));
  return JSON.stringify({ outbounds }, null, 2);
}

export function renderSubscription(
  format: SubFormat, user: UserRecord, nodes: NodeRecord[],
): { body: string; contentType: string } {
  if (format === "clash")
    return { body: buildClash(user, nodes), contentType: "text/yaml; charset=utf-8" };
  if (format === "singbox")
    return { body: buildSingbox(user, nodes), contentType: "application/json; charset=utf-8" };
  return { body: buildBase64(user, nodes), contentType: "text/plain; charset=utf-8" };
}

export function pickFormat(ua: string, override?: string | null): SubFormat {
  if (override === "clash" || override === "singbox" || override === "base64") return override;
  const u = ua.toLowerCase();
  if (u.includes("clash") || u.includes("mihomo") || u.includes("stash")) return "clash";
  if (u.includes("sing-box") || u.includes("singbox")) return "singbox";
  return "base64";
}
