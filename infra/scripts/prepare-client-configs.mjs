#!/usr/bin/env node

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EARLY_DATA = 2560;
const EARLY_DATA_HEADER = "Sec-WebSocket-Protocol";
const DEFAULT_PORTS = Object.freeze({
  xray: 18081,
  mihomo: 18082,
  singbox: 18083,
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function scalar(value) {
  const text = value.trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    return JSON.parse(text);
  }
  if (text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  return text;
}

function yamlField(block, indent, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(
    new RegExp(`^${" ".repeat(indent)}${escaped}:\\s*(.+?)\\s*$`, "m"),
  );
  assert(match, `Mihomo 订阅缺少 ${key}`);
  return scalar(match[1]);
}

function firstMihomoProxy(text) {
  const proxies = text.match(/^proxies:\s*\r?\n([\s\S]*?)(?=^proxy-groups:)/m);
  assert(proxies, "Mihomo 订阅缺少 proxies/proxy-groups");
  const markers = [...proxies[1].matchAll(/^  - name:/gm)];
  assert(markers.length > 0, "Mihomo 订阅没有代理条目");
  const start = markers[0].index;
  const end = markers[1]?.index ?? proxies[1].length;
  const block = proxies[1].slice(start, end);
  assert(!/^\s+skip-cert-verify:\s*true\s*$/mi.test(block), "Mihomo 禁止跳过证书校验");
  assert(!/^\s+alpn:\s*/mi.test(block), "Mihomo WebSocket 禁止强制 ALPN");
  return {
    name: yamlField(block, 2, "- name"),
    type: yamlField(block, 4, "type"),
    server: yamlField(block, 4, "server"),
    port: Number(yamlField(block, 4, "port")),
    uuid: yamlField(block, 4, "uuid"),
    network: yamlField(block, 4, "network"),
    tls: yamlField(block, 4, "tls") === "true",
    serverName: yamlField(block, 4, "servername"),
    fingerprint: yamlField(block, 4, "client-fingerprint"),
    path: yamlField(block, 6, "path"),
    host: yamlField(block, 8, "Host"),
    earlyData: Number(yamlField(block, 6, "max-early-data")),
    earlyDataHeader: yamlField(block, 6, "early-data-header-name"),
  };
}

function parseBase64Subscription(text) {
  const decoded = Buffer.from(text.trim(), "base64").toString("utf8");
  const link = decoded
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  assert(link?.startsWith("vless://"), "base64 订阅没有 VLESS 条目");
  const url = new URL(link);
  const path = url.searchParams.get("path");
  const serverName = url.searchParams.get("sni");
  const host = url.searchParams.get("host");
  assert(url.username, "Xray VLESS 条目缺少 UUID");
  assert(url.hostname, "Xray VLESS 条目缺少服务器地址");
  assert(Number(url.port || 443) === 443, "Xray VLESS 端口必须为 443");
  assert(url.searchParams.get("encryption") === "none", "Xray VLESS encryption 必须为 none");
  assert(url.searchParams.get("security") === "tls", "Xray VLESS 必须启用 TLS");
  assert(url.searchParams.get("type") === "ws", "Xray VLESS 必须使用 WebSocket");
  assert(serverName && host === serverName, "Xray VLESS 的 SNI 与 Host 必须一致");
  assert(url.searchParams.get("fp") === "chrome", "Xray VLESS 缺少稳定的 chrome 指纹值");
  assert(path?.startsWith("/"), "Xray VLESS 缺少绝对 WebSocket 路径");
  for (const key of ["allowInsecure", "insecure"]) {
    assert(
      !["1", "true"].includes((url.searchParams.get(key) || "").toLowerCase()),
      "Xray VLESS 禁止跳过证书校验",
    );
  }
  assert(!url.searchParams.has("alpn"), "Xray WebSocket 禁止强制 ALPN");
  const parsedPath = new URL(path, "https://opus8.invalid");
  assert(parsedPath.searchParams.get("ed") === String(EARLY_DATA), "Xray Early Data 参数错误");
  assert(
    [...parsedPath.searchParams.keys()].every((key) => key === "ed"),
    "Xray WebSocket 路径含未知查询参数",
  );
  return {
    address: url.hostname,
    port: 443,
    uuid: decodeURIComponent(url.username),
    serverName,
    host,
    path,
    pathName: parsedPath.pathname,
  };
}

function parseSingboxSubscription(text) {
  const parsed = JSON.parse(text);
  assert(Array.isArray(parsed.outbounds) && parsed.outbounds.length > 0, "sing-box 订阅没有 outbounds");
  const outbound = structuredClone(parsed.outbounds[0]);
  assert(outbound.type === "vless", "sing-box outbound 必须为 VLESS");
  assert(outbound.server && outbound.server_port === 443, "sing-box 服务器或端口无效");
  assert(outbound.uuid, "sing-box outbound 缺少 UUID");
  assert(outbound.tls?.enabled === true, "sing-box 必须启用 TLS");
  assert(outbound.tls?.insecure === false, "sing-box 禁止跳过证书校验");
  assert(outbound.tls?.utls?.enabled !== true, "sing-box 禁止依赖 uTLS 指纹伪装");
  assert(!outbound.tls?.alpn, "sing-box WebSocket 禁止强制 ALPN");
  assert(outbound.tls?.server_name, "sing-box 缺少 TLS server_name");
  assert(outbound.transport?.type === "ws", "sing-box 必须使用 WebSocket");
  assert(outbound.transport?.path?.startsWith("/"), "sing-box WebSocket 路径无效");
  assert(
    outbound.transport?.max_early_data === EARLY_DATA,
    "sing-box Early Data 数值错误",
  );
  assert(
    outbound.transport?.early_data_header_name === EARLY_DATA_HEADER,
    "sing-box Early Data 请求头错误",
  );
  assert(
    outbound.transport?.headers?.Host === outbound.tls.server_name,
    "sing-box 的 SNI 与 Host 必须一致",
  );
  return outbound;
}

function validatePorts(ports) {
  const values = Object.values(ports);
  assert(
    values.every((port) => Number.isSafeInteger(port) && port >= 1024 && port <= 65535),
    "本地 SOCKS 端口无效",
  );
  assert(new Set(values).size === values.length, "本地 SOCKS 端口不能重复");
}

export async function prepareClientConfigs({
  base64Path,
  mihomoPath,
  singboxPath,
  outputDir,
  ports = DEFAULT_PORTS,
}) {
  validatePorts(ports);
  const [base64Text, mihomoText, singboxText] = await Promise.all([
    readFile(base64Path, "utf8"),
    readFile(mihomoPath, "utf8"),
    readFile(singboxPath, "utf8"),
  ]);
  const xrayEntry = parseBase64Subscription(base64Text);
  const mihomoEntry = firstMihomoProxy(mihomoText);
  const singboxOutbound = parseSingboxSubscription(singboxText);

  assert(mihomoEntry.type === "vless", "Mihomo 代理必须为 VLESS");
  assert(mihomoEntry.network === "ws", "Mihomo 代理必须使用 WebSocket");
  assert(mihomoEntry.tls, "Mihomo 代理必须启用 TLS");
  assert(mihomoEntry.fingerprint === "chrome", "Mihomo 客户端指纹必须为 chrome");
  assert(mihomoEntry.earlyData === EARLY_DATA, "Mihomo Early Data 数值错误");
  assert(
    mihomoEntry.earlyDataHeader === EARLY_DATA_HEADER,
    "Mihomo Early Data 请求头错误",
  );
  assert(mihomoEntry.serverName === mihomoEntry.host, "Mihomo 的 SNI 与 Host 必须一致");

  const comparisons = [
    ["服务器地址", xrayEntry.address, mihomoEntry.server, singboxOutbound.server],
    ["UUID", xrayEntry.uuid, mihomoEntry.uuid, singboxOutbound.uuid],
    ["SNI", xrayEntry.serverName, mihomoEntry.serverName, singboxOutbound.tls.server_name],
    ["Host", xrayEntry.host, mihomoEntry.host, singboxOutbound.transport.headers.Host],
    ["WebSocket pathname", xrayEntry.pathName, mihomoEntry.path, singboxOutbound.transport.path],
  ];
  for (const [label, ...values] of comparisons) {
    assert(new Set(values).size === 1, `三种订阅的${label}不一致`);
  }
  assert(mihomoEntry.port === 443, "Mihomo 端口必须为 443");

  const xrayConfig = {
    log: { loglevel: "warning" },
    inbounds: [
      {
        tag: "socks-in",
        listen: "127.0.0.1",
        port: ports.xray,
        protocol: "socks",
        settings: { auth: "noauth", udp: false },
      },
    ],
    outbounds: [
      {
        tag: "opus8",
        protocol: "vless",
        settings: {
          vnext: [
            {
              address: xrayEntry.address,
              port: xrayEntry.port,
              users: [{ id: xrayEntry.uuid, encryption: "none" }],
            },
          ],
        },
        streamSettings: {
          network: "ws",
          security: "tls",
          tlsSettings: {
            serverName: xrayEntry.serverName,
            allowInsecure: false,
            fingerprint: "chrome",
          },
          wsSettings: {
            path: xrayEntry.path,
            headers: { Host: xrayEntry.host },
          },
        },
      },
    ],
  };

  const mihomoConfig = [
    `socks-port: ${ports.mihomo}`,
    "allow-lan: false",
    "bind-address: 127.0.0.1",
    "mode: rule",
    "log-level: warning",
    mihomoText.trim(),
    "",
  ].join("\n");

  const singboxConfig = {
    log: { level: "warn", timestamp: true },
    inbounds: [
      {
        type: "socks",
        tag: "socks-in",
        listen: "127.0.0.1",
        listen_port: ports.singbox,
      },
    ],
    outbounds: [singboxOutbound],
    route: { final: singboxOutbound.tag },
  };

  const metadata = {
    address: xrayEntry.address,
    port: 443,
    serverName: xrayEntry.serverName,
    path: xrayEntry.pathName,
    earlyData: EARLY_DATA,
    earlyDataHeader: EARLY_DATA_HEADER,
    clientPorts: ports,
  };

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDir, "xray.json"), `${JSON.stringify(xrayConfig, null, 2)}\n`),
    writeFile(resolve(outputDir, "mihomo.yaml"), mihomoConfig),
    writeFile(resolve(outputDir, "sing-box.json"), `${JSON.stringify(singboxConfig, null, 2)}\n`),
    writeFile(resolve(outputDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`),
  ]);
  return metadata;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    assert(key?.startsWith("--") && value, `参数无效: ${key || "(empty)"}`);
    values[key.slice(2)] = value;
  }
  for (const required of ["base64", "mihomo", "singbox", "output-dir"]) {
    assert(values[required], `缺少 --${required}`);
  }
  return values;
}

const invokedAsScript =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const metadata = await prepareClientConfigs({
      base64Path: resolve(args.base64),
      mihomoPath: resolve(args.mihomo),
      singboxPath: resolve(args.singbox),
      outputDir: resolve(args["output-dir"]),
    });
    process.stdout.write(
      `OK prepared host=${metadata.serverName} path=${metadata.path} earlyData=${metadata.earlyData}\n`,
    );
  } catch (error) {
    process.stderr.write(`ERROR ${(error instanceof Error && error.message) || String(error)}\n`);
    process.exitCode = 1;
  }
}
