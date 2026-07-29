#!/usr/bin/env node
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePolicy } from "./compliance-gate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const policyPath = resolve(here, "..", "compliance-policy.json");
const API_BASE = "https://api.cloudflare.com/client/v4";
const GRAPHQL_URL = `${API_BASE}/graphql`;

function finiteNumber(value) {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : 0;
}

export function evaluateAccountMetrics({
  alias,
  expectedWorkerNames,
  deployedWorkerNames,
  records,
  budget,
}) {
  const expected = new Set(expectedWorkerNames);
  const opus8Deployed = deployedWorkerNames.filter((name) =>
    name.startsWith("opus8cf-"),
  );
  const undeclaredOpus8Workers = opus8Deployed.filter(
    (name) => !expected.has(name),
  );
  const missingDeclaredWorkers = expectedWorkerNames.filter(
    (name) => !deployedWorkerNames.includes(name),
  );
  const relevant = records.filter((record) =>
    expected.has(String(record.dimensions?.scriptName || "")),
  );
  const totals = relevant.reduce(
    (result, record) => {
      const requests = finiteNumber(record.sum?.requests);
      result.requests += requests;
      result.errors += finiteNumber(record.sum?.errors);
      result.subrequests += finiteNumber(record.sum?.subrequests);
      result.cpuP99Microseconds = Math.max(
        result.cpuP99Microseconds,
        finiteNumber(record.quantiles?.cpuTimeP99),
      );
      if (record.dimensions?.status === "exceededResources") {
        result.exceededResources += requests;
      }
      return result;
    },
    {
      requests: 0,
      errors: 0,
      subrequests: 0,
      cpuP99Microseconds: 0,
      exceededResources: 0,
    },
  );
  const errorRate = totals.requests > 0 ? totals.errors / totals.requests : 0;
  const subrequestsPerRequest =
    totals.requests > 0 ? totals.subrequests / totals.requests : 0;
  const violations = [];
  if (totals.requests > budget.maxRequests) violations.push("request_budget");
  if (errorRate > budget.maxErrorRate) violations.push("error_rate");
  if (totals.cpuP99Microseconds > budget.maxCpuP99Microseconds) {
    violations.push("cpu_p99");
  }
  if (subrequestsPerRequest > budget.maxSubrequestsPerRequest) {
    violations.push("subrequests_per_request");
  }
  if (totals.exceededResources > 0) {
    violations.push("exceeded_resources");
  }
  if (undeclaredOpus8Workers.length > 0) {
    violations.push("undeclared_opus8_workers");
  }
  return {
    alias,
    expectedWorkerNames,
    deployedOpus8WorkerNames: opus8Deployed,
    undeclaredOpus8Workers,
    missingDeclaredWorkers,
    totals,
    rates: { errorRate, subrequestsPerRequest },
    budget,
    violations,
    ok: violations.length === 0,
  };
}

async function cloudflareRequest(path, token, init = {}) {
  const response = await fetch(path.startsWith("http") ? path : API_BASE + path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Cloudflare API HTTP ${response.status}`);
  }
  return payload;
}

async function deployedScripts(accountId, token) {
  const payload = await cloudflareRequest(
    `/accounts/${encodeURIComponent(accountId)}/workers/scripts`,
    token,
  );
  if (payload?.success !== true || !Array.isArray(payload.result)) {
    throw new Error("Workers Scripts response is invalid");
  }
  return payload.result
    .map((item) => String(item?.id || ""))
    .filter((item) => /^[a-z0-9-]+$/.test(item));
}

async function invocationMetrics(accountId, token, start, end) {
  const query = `
    query Opus8WorkersAudit(
      $accountTag: string,
      $datetimeStart: string,
      $datetimeEnd: string
    ) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptive(
            limit: 1000,
            filter: {
              datetime_geq: $datetimeStart,
              datetime_lt: $datetimeEnd
            }
          ) {
            sum {
              requests
              errors
              subrequests
            }
            quantiles {
              cpuTimeP99
            }
            dimensions {
              scriptName
              status
            }
          }
        }
      }
    }
  `;
  const payload = await cloudflareRequest(GRAPHQL_URL, token, {
    method: "POST",
    body: JSON.stringify({
      query,
      variables: {
        accountTag: accountId,
        datetimeStart: start,
        datetimeEnd: end,
      },
    }),
  });
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new Error(
      `GraphQL Analytics rejected the query: ${String(
        payload.errors[0]?.message || "unknown error",
      ).slice(0, 180)}`,
    );
  }
  const accounts = payload?.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) {
    throw new Error(
      "GraphQL Analytics did not return exactly one account; verify Analytics Read permission",
    );
  }
  const records = accounts[0]?.workersInvocationsAdaptive;
  if (!Array.isArray(records)) {
    throw new Error("GraphQL Workers metrics dataset is unavailable");
  }
  return records;
}

function markdownReport(report) {
  const lines = [
    "## Cloudflare resource and topology audit",
    "",
    `Window: \`${report.window.start}\` to \`${report.window.end}\``,
    "",
    "| Account | Requests | Error rate | CPU P99 (µs) | Subrequests/request | Undeclared Opus8 Workers | Result |",
    "|---|---:|---:|---:|---:|---:|---|",
  ];
  for (const account of report.accounts) {
    if (account.error) {
      lines.push(
        `| ${account.alias} | — | — | — | — | — | ERROR: ${account.error.replaceAll("|", "\\|")} |`,
      );
      continue;
    }
    lines.push(
      `| ${account.alias} | ${account.totals.requests} | ${(account.rates.errorRate * 100).toFixed(3)}% | ${account.totals.cpuP99Microseconds.toFixed(2)} | ${account.rates.subrequestsPerRequest.toFixed(3)} | ${account.undeclaredOpus8Workers.length} | ${account.ok ? "PASS" : `BLOCK: ${account.violations.join(", ")}`} |`,
    );
    if (account.undeclaredOpus8Workers.length > 0) {
      lines.push(
        "",
        `- ${account.alias} undeclared Workers: ${account.undeclaredOpus8Workers
          .map((name) => `\`${name}\``)
          .join(", ")}`,
      );
    }
    if (account.missingDeclaredWorkers.length > 0) {
      lines.push(
        "",
        `- ${account.alias} declared but not deployed: ${account.missingDeclaredWorkers
          .map((name) => `\`${name}\``)
          .join(", ")}`,
      );
    }
  }
  lines.push(
    "",
    "This workflow is read-only. It writes no KV, D1, Analytics Engine, email, chat, or webhook events.",
    "",
  );
  return lines.join("\n");
}

async function main() {
  const policy = validatePolicy(
    JSON.parse(await readFile(policyPath, "utf8")),
  );
  const end = new Date();
  const start = new Date(
    end.getTime() - policy.resourceBudgets.windowHours * 3_600_000,
  );
  const accounts = [];
  for (const [alias, topology] of Object.entries(
    policy.currentTopology.accounts,
  )) {
    const suffix = alias.toUpperCase().replaceAll("-", "_");
    const accountId = process.env[`CF_ACCOUNT_${suffix}`] || "";
    const token = process.env[`CF_TOKEN_${suffix}`] || "";
    if (!accountId || !token) {
      accounts.push({
        alias,
        error: "account ID or API token is missing",
        ok: false,
      });
      continue;
    }
    try {
      const [scripts, records] = await Promise.all([
        deployedScripts(accountId, token),
        invocationMetrics(
          accountId,
          token,
          start.toISOString(),
          end.toISOString(),
        ),
      ]);
      accounts.push(
        evaluateAccountMetrics({
          alias,
          expectedWorkerNames: topology.workerNames,
          deployedWorkerNames: scripts,
          records,
          budget: policy.resourceBudgets.perAccount[alias],
        }),
      );
    } catch (error) {
      accounts.push({
        alias,
        error: String(error.message || error).slice(0, 240),
        ok: false,
      });
    }
  }
  const report = {
    schemaVersion: 1,
    generatedAt: end.toISOString(),
    window: { start: start.toISOString(), end: end.toISOString() },
    storageWrites: { kv: 0, d1: 0, analyticsEngine: 0 },
    accounts,
    ok: accounts.every((account) => account.ok),
  };
  const outputPath = process.env.RESOURCE_AUDIT_OUTPUT || "";
  if (outputPath) {
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  const markdown = markdownReport(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  } else {
    process.stdout.write(markdown);
  }
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`ERROR resource-audit ${error.message}\n`);
    process.exitCode = 2;
  });
}
