#!/usr/bin/env bash
# Maintains one GitHub issue for active Opus8 health alerts and optionally
# publishes state changes to a generic JSON webhook.
set -uo pipefail

: "${HEALTH_ALERT_FILE:?HEALTH_ALERT_FILE is required}"

REPOSITORY="${GH_REPO:-${GITHUB_REPOSITORY:-}}"
RUN_URL="${RUN_URL:-${GITHUB_SERVER_URL:-https://github.com}/${REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-unknown}}"
PROBE_OUTCOME="${HEALTHCHECK_OUTCOME:-unknown}"
LABEL="opus8-health-alert"
ISSUE_TITLE="[Opus8] 运行健康告警"
STATE_AVAILABLE=false
ACTIVE_COUNT=0
CHANGE_COUNT=0
EVENT_STATUS=alert

if [ "$PROBE_OUTCOME" = "success" ] && [ -s "$HEALTH_ALERT_FILE" ]; then
  STATE_AVAILABLE=true
  ACTIVE_COUNT="$(jq '
    ([.nodes[] | select(.enabled == 1 and .health != "healthy")] | length) +
    ([.landings[] | select(.enabled == true and .health != "healthy")] | length)
  ' "$HEALTH_ALERT_FILE")"
  CHANGE_COUNT="$(jq '
    (.transitions | length) +
    ([.landings[] | select(.transition == true)] | length)
  ' "$HEALTH_ALERT_FILE")"
  BODY="$(jq -r --arg runUrl "$RUN_URL" '
    "<!-- opus8-health-alert -->\n" +
    "自动健康检查发现以下异常。边缘节点会按既定阈值摘除或恢复；落地机连接失败时，节点会继续尝试下一台可用落地机。\n\n" +
    "### 当前汇总\n\n" +
    "- 健康节点：\(.summary.healthy)\n" +
    "- 降级节点：\(.summary.degraded)\n" +
    "- 已摘除节点：\(.summary.banned)\n" +
    "- 检查时间：\(now | todate)\n\n" +
    "### 异常节点\n\n" +
    (([.nodes[] |
      select(.enabled == 1 and .health != "healthy") |
      "- `\(.id)`：**\(.health)** — \(.health_last_error // "暂无错误详情")"
    ] | if length == 0 then ["- 无"] else . end | join("\n"))) +
    "\n\n### 异常落地机\n\n" +
    (([.landings[] |
      select(.enabled == true and .health != "healthy") |
      "- `\(.name)`：**\(.health)** — \(.error // "暂无错误详情")"
    ] | if length == 0 then ["- 无"] else . end | join("\n"))) +
    "\n\n[查看本次健康检查](\($runUrl))"
  ' "$HEALTH_ALERT_FILE")"
else
  ACTIVE_COUNT=1
  CHANGE_COUNT=1
  BODY="<!-- opus8-health-alert -->
健康检查任务自身执行失败，当前无法确认节点与落地机状态。

- 任务结果：\`$PROBE_OUTCOME\`
- [查看失败日志]($RUN_URL)"
fi

notify_webhook() {
  local event="$1"
  [ -n "${ALERT_WEBHOOK_URL:-}" ] || return 0
  local payload
  if [ "$STATE_AVAILABLE" = true ]; then
    payload="$(jq -c \
      --arg event "$event" \
      --arg runUrl "$RUN_URL" \
      '{
        event:("opus8.health." + $event),
        runUrl:$runUrl,
        runId:.runId,
        generatedAt:.generatedAt,
        summary:.summary,
        transitions:.transitions,
        nodes:[.nodes[] | {
          id,hostname,health,
          directOk:.health_direct_ok,
          landingOk:.health_landing_ok,
          error:.health_last_error
        }],
        landings:.landings
      }' "$HEALTH_ALERT_FILE")"
  else
    payload="$(jq -nc \
      --arg event "$event" \
      --arg runUrl "$RUN_URL" \
      --arg outcome "$PROBE_OUTCOME" \
      '{event:("opus8.health." + $event),runUrl:$runUrl,outcome:$outcome}')"
  fi
  if curl -fsS --max-time 20 --retry 2 --retry-all-errors \
    -H 'content-type: application/json' \
    --data "$payload" "$ALERT_WEBHOOK_URL" >/dev/null; then
    echo "OK alert-webhook event=$event"
  else
    echo "::warning::Health webhook delivery failed"
  fi
}

ISSUE_NUMBER=""
if [ -n "${GH_TOKEN:-}" ] && [ -n "$REPOSITORY" ]; then
  gh label create "$LABEL" \
    --repo "$REPOSITORY" \
    --color D73A4A \
    --description "Managed by the Opus8 production health monitor" \
    --force >/dev/null 2>&1 || true
  ISSUE_NUMBER="$(gh issue list \
    --repo "$REPOSITORY" \
    --state open \
    --label "$LABEL" \
    --json number \
    --jq '.[0].number // empty' 2>/dev/null || true)"
fi

if [ "$ACTIVE_COUNT" -gt 0 ]; then
  EVENT_STATUS=alert
  if [ -n "${GH_TOKEN:-}" ] && [ -n "$REPOSITORY" ]; then
    if [ -z "$ISSUE_NUMBER" ]; then
      if gh issue create \
        --repo "$REPOSITORY" \
        --title "$ISSUE_TITLE" \
        --label "$LABEL" \
        --body "$BODY" >/dev/null; then
        echo "OK alert-issue-created"
        notify_webhook alert
      else
        echo "::warning::Unable to create the health alert issue"
        notify_webhook alert
      fi
    else
      gh issue edit "$ISSUE_NUMBER" \
        --repo "$REPOSITORY" \
        --body "$BODY" >/dev/null 2>&1 ||
        echo "::warning::Unable to update health alert issue #$ISSUE_NUMBER"
      if [ "$CHANGE_COUNT" -gt 0 ]; then
        gh issue comment "$ISSUE_NUMBER" \
          --repo "$REPOSITORY" \
          --body "检测到新的状态变化：[查看本次健康检查]($RUN_URL)" >/dev/null 2>&1 ||
          echo "::warning::Unable to comment on health alert issue #$ISSUE_NUMBER"
        notify_webhook alert
      fi
      echo "OK alert-issue-active number=$ISSUE_NUMBER"
    fi
  else
    echo "::warning::GH_TOKEN or repository is unavailable; GitHub issue notification skipped"
    notify_webhook alert
  fi
else
  EVENT_STATUS=recovered
  if [ -n "$ISSUE_NUMBER" ] && [ -n "${GH_TOKEN:-}" ]; then
    gh issue comment "$ISSUE_NUMBER" \
      --repo "$REPOSITORY" \
      --body "所有节点与落地机均已恢复正常。[查看恢复检查]($RUN_URL)" >/dev/null 2>&1 ||
      echo "::warning::Unable to comment on health alert issue #$ISSUE_NUMBER"
    gh issue close "$ISSUE_NUMBER" \
      --repo "$REPOSITORY" \
      --reason completed >/dev/null 2>&1 ||
      echo "::warning::Unable to close health alert issue #$ISSUE_NUMBER"
    echo "OK alert-issue-closed number=$ISSUE_NUMBER"
    notify_webhook recovered
  else
    echo "OK no-active-health-alerts"
  fi
fi

echo "DONE alert-status=$EVENT_STATUS active=$ACTIVE_COUNT changes=$CHANGE_COUNT"
