import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type NodeRow,
  type OptimizedIpPoolResponse,
  type OptimizedNodeIpPool,
} from "../api";
import { relTime, fmtTime, copy } from "../util";

const OPTIMIZE_WORKFLOW_URL =
  "https://github.com/FengHaoyun-MONSTER/Opus8-CF/actions/workflows/optimize-ip.yml";

function healthText(health: string): string {
  if (health === "healthy") return "正常";
  if (health === "degraded") return "降级";
  if (health === "banned") return "已摘除";
  return "未检查";
}

function probeText(
  ok: number | null | undefined,
  latency: number | null | undefined,
): string {
  if (ok === 1) return `正常${latency == null ? "" : ` · ${latency} ms`}`;
  if (ok === 0) return "失败";
  return "未执行";
}

function remainingText(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left <= 0) return "已过期";
  const hours = Math.floor(left / 3_600_000);
  const minutes = Math.max(1, Math.floor((left % 3_600_000) / 60_000));
  return hours > 0 ? `${hours} 小时 ${minutes} 分钟后` : `${minutes} 分钟后`;
}

function optimizationState(
  node: NodeRow,
  optimized: OptimizedIpPoolResponse | null,
): {
  tone: "active" | "fallback" | "disabled";
  label: string;
  reason: string;
  pool: OptimizedNodeIpPool | null;
} {
  if (node.enabled !== 1 || node.health === "banned") {
    return {
      tone: "disabled",
      label: "未下发",
      reason:
        node.enabled !== 1
          ? "节点已停用，不会进入用户订阅"
          : "节点已被健康检查摘除，不会进入用户订阅",
      pool: null,
    };
  }
  if (!optimized?.subscriptionEnabled) {
    return {
      tone: "disabled",
      label: "域名模式",
      reason: "订阅侧尚未启用优选 IP 展开",
      pool: null,
    };
  }
  const pool = optimized.pool?.nodes[node.id] || null;
  if (!pool) {
    return {
      tone: "fallback",
      label: "域名回退",
      reason: "当前没有未过期的双视角安全候选",
      pool: null,
    };
  }
  if (pool.hostname !== node.hostname) {
    return {
      tone: "fallback",
      label: "域名回退",
      reason: "节点主机名已变化，旧优选记录不会进入订阅",
      pool,
    };
  }
  return {
    tone: "active",
    label: "优选生效",
    reason: "已通过 GitHub Runner 与落地 VPS 双视角验证",
    pool,
  };
}

export function Nodes() {
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [optimized, setOptimized] = useState<OptimizedIpPoolResponse | null>(
    null,
  );
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    try {
      const [nodeResponse, optimizedResponse] = await Promise.all([
        api.listNodes(),
        api.optimizedIps(),
      ]);
      setNodes(nodeResponse.nodes);
      setOptimized(optimizedResponse);
      setNow(Date.now());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const refreshTimer = window.setInterval(() => void refresh(true), 60_000);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      window.clearInterval(refreshTimer);
      window.clearInterval(clockTimer);
    };
  }, [refresh]);

  const optimizationRows = useMemo(
    () =>
      nodes.map((node) => ({
        node,
        state: optimizationState(node, optimized),
      })),
    [nodes, optimized],
  );
  const activeNodeCount = optimizationRows.filter(
    ({ state }) => state.tone === "active",
  ).length;
  const activeIpCount = optimizationRows.reduce(
    (sum, { state }) =>
      sum + (state.tone === "active" ? state.pool?.ips.length || 0 : 0),
    0,
  );
  const earliestExpiry = Math.min(
    ...optimizationRows
      .filter(({ state }) => state.tone === "active" && state.pool)
      .map(({ state }) => state.pool!.expiresAt),
  );

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h2>节点管理</h2>
          <div className="muted">
            健康检查每 10 分钟执行；优选任务每 4 小时从两个网络视角验证真实
            VLESS 连接。
          </div>
        </div>
        <button
          className="btn-ghost"
          disabled={refreshing}
          onClick={() => void refresh(true)}
        >
          {refreshing ? "刷新中…" : "刷新"}
        </button>
      </div>

      {error && <div className="err">{error}</div>}

      <section className="optimization-panel">
        <div className="optimization-head">
          <div>
            <h3>按节点优选 IP 池</h3>
            <div className="optimization-summary">
              <span className="optimization-metric">
                覆盖 <strong>{activeNodeCount}</strong> / {nodes.length} 个节点
              </span>
              <span className="optimization-metric">
                当前 <strong>{activeIpCount}</strong> 个安全 IP
              </span>
              <span className="optimization-metric">
                {Number.isFinite(earliestExpiry)
                  ? `最早 ${remainingText(earliestExpiry, now)}过期`
                  : "当前全部使用域名回退"}
              </span>
            </div>
          </div>
          <a
            className="btn-primary optimize-link"
            href={OPTIMIZE_WORKFLOW_URL}
            target="_blank"
            rel="noreferrer"
          >
            打开重新优选任务
          </a>
        </div>
        <div className="optimization-help">
          重新优选需要仓库写入权限。进入任务页面后选择“Run workflow”；浏览器不会保存
          GitHub Token。单个节点验证失败时只回退该节点域名，不影响其他节点。
        </div>

        {loading && nodes.length === 0 ? (
          <div className="muted">正在读取优选池…</div>
        ) : (
          <div className="optimization-grid">
            {optimizationRows.map(({ node, state }) => (
              <article
                className={`optimization-card optimization-${state.tone}`}
                key={node.id}
              >
                <div className="optimization-card-head">
                  <div>
                    <strong>{node.id}</strong>
                    <div className="mono muted">{node.hostname}</div>
                  </div>
                  <span className={`optimization-state state-${state.tone}`}>
                    {state.label}
                  </span>
                </div>
                {state.tone === "active" && state.pool ? (
                  <>
                    <div className="optimized-ips">
                      {state.pool.ips.map((ip) => (
                        <button
                          className="ip-chip mono"
                          key={ip}
                          title="点击复制 IP"
                          onClick={() => void copy(ip)}
                        >
                          {ip}
                        </button>
                      ))}
                    </div>
                    <div className="optimization-meta">
                      <span>
                        验证于 {fmtTime(state.pool.validatedAt)}
                      </span>
                      <span>
                        有效期至 {fmtTime(state.pool.expiresAt)}（
                        {remainingText(state.pool.expiresAt, now)}）
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="optimization-fallback">
                    订阅连接地址：<span className="mono">{node.hostname}</span>
                  </div>
                )}
                <div className="optimization-reason">{state.reason}</div>
              </article>
            ))}
          </div>
        )}
      </section>

      <h3>节点健康状态</h3>
      {loading && nodes.length === 0 ? (
        <div className="muted">加载中…</div>
      ) : nodes.length === 0 ? (
        <div className="muted">
          还没有节点注册。CI 批量部署边缘节点后，节点会自动出现在这里。
        </div>
      ) : (
        <div className="table-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>节点</th>
                <th>域名 / 地区</th>
                <th>订阅状态</th>
                <th>真实探测</th>
                <th>连续结果</th>
                <th>最后检查</th>
                <th>心跳</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node) => (
                <tr key={node.id}>
                  <td>
                    <strong
                      className="mono"
                      onClick={() => void copy(node.id)}
                      title="点击复制完整 Node ID"
                    >
                      {node.id}
                    </strong>
                    <div className="muted">{node.account_alias}</div>
                  </td>
                  <td>
                    <div className="mono">{node.hostname || "—"}</div>
                    <div className="mono muted">
                      WS {node.transport_path || "/"}
                    </div>
                    <div className="muted">
                      {node.region || "未标注"}
                      {node.preferred_ip ? ` · 心跳 IP ${node.preferred_ip}` : ""}
                    </div>
                  </td>
                  <td>
                    <span className={`pill pill-${node.health}`}>
                      {healthText(node.health)}
                    </span>
                    {node.enabled !== 1 && (
                      <div className="muted">已停用</div>
                    )}
                  </td>
                  <td>
                    <div
                      className={
                        node.health_direct_ok === 0 ? "text-danger" : ""
                      }
                    >
                      直连：
                      {probeText(
                        node.health_direct_ok,
                        node.health_direct_latency_ms,
                      )}
                    </div>
                    <div
                      className={
                        node.health_landing_ok === 0 ? "text-danger" : "muted"
                      }
                    >
                      落地：
                      {probeText(
                        node.health_landing_ok,
                        node.health_landing_latency_ms,
                      )}
                    </div>
                  </td>
                  <td>
                    <div>失败 {node.health_consecutive_failures || 0} 次</div>
                    <div className="muted">
                      成功 {node.health_consecutive_successes || 0} 次
                    </div>
                  </td>
                  <td>
                    <div>{relTime(node.health_last_checked ?? null)}</div>
                    {node.health_last_error && (
                      <div className="muted" title={node.health_last_error}>
                        {node.health_last_error.slice(0, 42)}
                      </div>
                    )}
                    {!node.health_last_checked && (
                      <div className="muted">等待首次定时检查</div>
                    )}
                  </td>
                  <td>
                    <div>{relTime(node.last_seen)}</div>
                    <div className="muted">
                      注册于 {fmtTime(node.created_at)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
