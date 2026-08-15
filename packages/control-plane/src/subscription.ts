import {
  nodeTransportPath,
  TRANSPORT_EARLY_DATA,
  TRANSPORT_EARLY_DATA_HEADER,
  xrayWebSocketPath,
  type NodeRecord,
  type UserRecord,
  type SubFormat,
} from "@opus8-cf/shared";
import { userAssignedToNode } from "./node-assignment";

const MAX_IPS_PER_NODE = 3;

function nodeName(n: NodeRecord): string {
  return `Opus8-${n.region || n.account_alias}-${n.id.slice(0, 6)}`;
}

/** 选出分配给该用户的节点（node_group 为空=全部启用且健康）。 */
export function nodesForUser(user: UserRecord, all: NodeRecord[]): NodeRecord[] {
  const healthy = all.filter(
    (n) =>
      n.enabled === 1 &&
      n.health !== "banned" &&
      nodeTransportPath(n.transport_path) !== null,
  );
  return healthy.filter((node) =>
    userAssignedToNode(user.node_group, node.id, node.account_alias),
  );
}

interface Entry {
  node: NodeRecord;
  address: string; // 连接地址：优选IP 或 节点域名
  name: string;
}

export type OptimizedIpsByNode = Record<string, string[]>;

/** 把节点展开成订阅条目：有优选IP时每节点多条(不同IP)，否则每节点一条。 */
function expand(
  nodes: NodeRecord[],
  optIpsByNode: OptimizedIpsByNode,
): Entry[] {
  const entries: Entry[] = [];
  for (const n of nodes) {
    const ips = (optIpsByNode?.[n.id] || []).slice(0, MAX_IPS_PER_NODE);
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
  const path = nodeTransportPath(e.node.transport_path);
  if (!path) throw new Error(`节点 ${e.node.id} 的传输路径无效`);
  const q = new URLSearchParams({
    encryption: "none",
    security: "tls",
    sni: host,
    fp: "chrome",
    type: "ws",
    host,
    path: xrayWebSocketPath(path),
  });
  return `vless://${uuid}@${e.address}:443?${q.toString()}#${encodeURIComponent(e.name)}`;
}

function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function buildBase64(
  user: UserRecord,
  entries: Entry[],
  credentialUuid = user.uuid,
): string {
  return utf8ToBase64(entries.map((e) => vlessLink(credentialUuid, e)).join("\n"));
}

export function buildClash(
  user: UserRecord,
  entries: Entry[],
  credentialUuid = user.uuid,
): string {
  const names: string[] = [];
  const proxies = entries.map((e) => {
    names.push(e.name);
    const path = nodeTransportPath(e.node.transport_path);
    if (!path) throw new Error(`节点 ${e.node.id} 的传输路径无效`);
    return [
      `  - name: "${e.name}"`,
      `    type: vless`,
      `    server: ${e.address}`,
      `    port: 443`,
      `    uuid: ${credentialUuid}`,
      `    network: ws`,
      `    tls: true`,
      `    udp: true`,
      `    servername: ${e.node.hostname}`,
      `    client-fingerprint: chrome`,
      `    ws-opts:`,
      `      path: "${path}"`,
      `      headers:`,
      `        Host: ${e.node.hostname}`,
      `      max-early-data: ${TRANSPORT_EARLY_DATA}`,
      `      early-data-header-name: ${TRANSPORT_EARLY_DATA_HEADER}`,
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

export function buildSingbox(
  user: UserRecord,
  entries: Entry[],
  credentialUuid = user.uuid,
): string {
  const outbounds = entries.map((e) => {
    const path = nodeTransportPath(e.node.transport_path);
    if (!path) throw new Error(`节点 ${e.node.id} 的传输路径无效`);
    return {
      type: "vless",
      tag: e.name,
      server: e.address,
      server_port: 443,
      uuid: credentialUuid,
      // sing-box 官方已明确不建议依赖 uTLS 做指纹抵抗；保留系统 TLS 与严格证书校验。
      tls: { enabled: true, server_name: e.node.hostname, insecure: false },
      transport: {
        type: "ws",
        path,
        headers: { Host: e.node.hostname },
        max_early_data: TRANSPORT_EARLY_DATA,
        early_data_header_name: TRANSPORT_EARLY_DATA_HEADER,
      },
    };
  });
  return JSON.stringify({ outbounds }, null, 2);
}

export function renderSubscription(
  format: SubFormat,
  user: UserRecord,
  nodes: NodeRecord[],
  optIpsByNode: OptimizedIpsByNode = {},
  credentialUuid = user.uuid,
): { body: string; contentType: string } {
  const entries = expand(nodes, optIpsByNode);
  if (format === "clash")
    return {
      body: buildClash(user, entries, credentialUuid),
      contentType: "text/yaml; charset=utf-8",
    };
  if (format === "singbox")
    return {
      body: buildSingbox(user, entries, credentialUuid),
      contentType: "application/json; charset=utf-8",
    };
  return {
    body: buildBase64(user, entries, credentialUuid),
    contentType: "text/plain; charset=utf-8",
  };
}

export function pickFormat(ua: string, override?: string | null): SubFormat {
  if (override === "clash" || override === "singbox" || override === "base64") return override;
  const u = ua.toLowerCase();
  if (u.includes("clash") || u.includes("mihomo") || u.includes("stash")) return "clash";
  if (u.includes("sing-box") || u.includes("singbox")) return "singbox";
  return "base64";
}
