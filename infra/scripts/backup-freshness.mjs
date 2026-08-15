import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_AGE_HOURS = 26;
const ISSUE_TITLE = "[Opus8] D1 encrypted backup is stale";

export function evaluateBackupFreshness(runs, now = Date.now(), maxAgeHours = DEFAULT_MAX_AGE_HOURS) {
  if (!Array.isArray(runs)) throw new Error("workflow runs must be an array");
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
    throw new Error("invalid backup freshness boundary");
  }
  const successful = runs
    .filter((run) => run?.conclusion === "success")
    .map((run) => ({
      id: Number(run.id || run.databaseId || 0),
      url: typeof run.html_url === "string" ? run.html_url : String(run.url || ""),
      completedAt: Date.parse(String(run.updated_at || run.completedAt || run.created_at || "")),
    }))
    .filter((run) => Number.isSafeInteger(run.id) && run.id > 0 && Number.isFinite(run.completedAt))
    .sort((a, b) => b.completedAt - a.completedAt);
  const latest = successful[0] || null;
  const maxAgeMs = maxAgeHours * 60 * 60_000;
  const ageMs = latest ? Math.max(0, now - latest.completedAt) : null;
  return {
    healthy: latest !== null && ageMs !== null && ageMs <= maxAgeMs,
    checkedAt: now,
    maxAgeHours,
    ageHours: ageMs === null ? null : ageMs / 3_600_000,
    latest,
  };
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function github(path, init = {}) {
  const repository = requiredEnv("GITHUB_REPOSITORY");
  const token = requiredEnv("GH_TOKEN");
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "opus8-backup-freshness",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${data?.message || "request failed"}`);
  return data;
}

async function findOpenIssue() {
  const issues = await github(`/issues?state=open&per_page=100`);
  return issues.find((issue) => issue.title === ISSUE_TITLE && !issue.pull_request) || null;
}

async function reconcileIssue(result) {
  const existing = await findOpenIssue();
  if (result.healthy) {
    if (!existing) return "healthy-no-issue";
    await github(`/issues/${existing.number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: `Backup freshness recovered at ${new Date(result.checkedAt).toISOString()}. Latest successful run: ${result.latest.url}` }),
    });
    await github(`/issues/${existing.number}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
    return "recovered-issue-closed";
  }
  const age = result.ageHours === null ? "no successful run found" : `${result.ageHours.toFixed(1)} hours old`;
  const body = [
    "The encrypted D1 backup freshness objective is not being met.",
    "",
    `- Checked: ${new Date(result.checkedAt).toISOString()}`,
    `- Maximum age: ${result.maxAgeHours} hours`,
    `- Latest success: ${age}`,
    result.latest?.url ? `- Run: ${result.latest.url}` : "- Run: unavailable",
    "",
    "Investigate the d1-backup workflow. Do not restore into the production database while diagnosing this alert.",
  ].join("\n");
  if (existing) {
    await github(`/issues/${existing.number}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    });
    return "stale-issue-refreshed";
  }
  await github("/issues", { method: "POST", body: JSON.stringify({ title: ISSUE_TITLE, body }) });
  return "stale-issue-created";
}

async function main() {
  const maxAgeHours = Number(process.env.BACKUP_MAX_AGE_HOURS || DEFAULT_MAX_AGE_HOURS);
  const data = await github("/actions/workflows/d1-backup.yml/runs?status=completed&per_page=30");
  const result = evaluateBackupFreshness(data.workflow_runs, Date.now(), maxAgeHours);
  const action = await reconcileIssue(result);
  console.log(`OK backup-freshness healthy=${result.healthy ? 1 : 0} action=${action}`);
  if (!result.healthy) process.exitCode = 2;
}

if (
  process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(`ERROR backup-freshness ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
