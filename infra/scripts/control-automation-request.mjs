#!/usr/bin/env node
import crypto from "node:crypto";

const [methodArg, urlArg] = process.argv.slice(2);
const method = String(methodArg || "GET").toUpperCase();
const target = String(urlArg || "");
const secret = process.env.CONTROL_AUTOMATION_SECRET || "";
const identity = process.env.CONTROL_AUTOMATION_ID || "github-node-deploy";
if (!/^(GET|POST|DELETE)$/.test(method) || !/^https:\/\//.test(target)) {
  throw new Error("usage: control-automation-request.mjs GET|POST|DELETE https://control.example/path");
}
if (secret.length < 32) throw new Error("CONTROL_AUTOMATION_SECRET is missing or too short");
if (!/^[A-Za-z0-9._-]{3,64}$/.test(identity)) throw new Error("invalid CONTROL_AUTOMATION_ID");

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const body = Buffer.concat(chunks).toString("utf8");
const timestamp = String(Date.now());
const requestId = crypto.randomUUID();
const parsed = new URL(target);
const requestTarget = `${parsed.pathname}${parsed.search}`;
const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
const message = [
  "opus8-automation-v1",
  timestamp,
  identity,
  requestId,
  method,
  requestTarget,
  bodyHash,
].join("\n");
const signature = crypto.createHmac("sha256", secret).update(message).digest("hex");
const response = await fetch(target, {
  method,
  headers: {
    "content-type": "application/json",
    "x-opus8-automation-id": identity,
    "x-opus8-automation-timestamp": timestamp,
    "x-opus8-automation-request-id": requestId,
    "x-opus8-automation-signature": signature,
  },
  body: method === "GET" ? undefined : body,
  signal: AbortSignal.timeout(20_000),
});
const responseText = await response.text();
if (!response.ok) {
  process.stderr.write(`control automation request failed: HTTP ${response.status}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(responseText);
}
