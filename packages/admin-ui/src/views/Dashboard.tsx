import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type OperationsOverview } from "../api";
import { fmtBytes, fmtNumber, relTime } from "../util";

interface Stat {
  label: string;
  value: string;
  hint: string;
  tone: "a" | "b" | "c" | "d" | "e" | "f";
}

function hourLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusText(severity: "healthy" | "warning" | "danger"): string {
  if (severity === "danger") return "受限";
  if (severity === "warning") return "关注";
  return "正常";
}

export function Dashboard() {
  const [overview, setOverview] = useState<OperationsOverview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    try {
      setOverview(await api.operationsOverview());
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
    const timer = window.setInterval(() => void refresh(true), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const chartMax = useMemo(
    () =>
      Math.max(
        1,
        ...(overview?.series.map((item) => item.bytesUp + item.bytesDown) || [
          1,
        ]),
      ),
    [overview],
  );

  if (loading && !overview)
    return <div className="loading-state">正在读取运营数据…</div>;

  const summary = overview?.summary;
  const stats: Stat[] = summary
    ? [
        {
          label: "24 小时流量",
          value: fmtBytes(summary.windowTrafficBytes, true),
          hint: `累计 ${fmtBytes(summary.totalTrafficBytes, true)}`,
          tone: "a",
        },
        {
          label: "24 小时连接",
          value: fmtNumber(summary.windowConnections),
          hint: `${summary.activeIps} 个 IP 当前在线`,
          tone: "b",
        },
        {
          label: "有效用户",
          value: `${summary.activeUsers} / ${summary.totalUsers}`,
          hint: `${summary.attentionUsers} 个需关注`,
          tone: "c",
        },
        {
          label: "受限用户",
          value: String(summary.blockedUsers),
          hint: "停用、过期或额度耗尽",
          tone: "d",
        },
        {
          label: "边缘节点",
          value: `${summary.healthyNodes} / ${summary.totalNodes}`,
          hint: "健康 / 总数",
          tone: "e",
        },
        {
          label: "落地出口",
          value: `${summary.healthyLandings} / ${summary.totalLandings}`,
          hint: summary.unhealthyLandings
            ? `${summary.unhealthyLandings} 个异常`
            : "Dante / WARP",
          tone: "f",
        },
      ]
    : [];

  return (
    <div className="view operations-view">
      <div className="view-head operations-head">
        <div>
          <div className="eyebrow">OPERATIONS</div>
          <h2>运营总览</h2>
          <div className="muted">
            连接、流量、防分享限制与出口健康状态，每 30 秒自动更新。
          </div>
        </div>
        <div className="refresh-block">
          <span className="muted">
            {overview
              ? `更新于 ${new Date(overview.generatedAt).toLocaleTimeString("zh-CN")}`
              : "—"}
          </span>
          <button
            className="btn-ghost"
            onClick={() => void refresh(true)}
            disabled={refreshing}
          >
            {refreshing ? "刷新中…" : "立即刷新"}
          </button>
        </div>
      </div>

      {error && <div className="err">{error}</div>}

      <div className="ops-stat-grid">
        {stats.map((stat) => (
          <article key={stat.label} className={`stat stat-${stat.tone}`}>
            <div className="stat-label">{stat.label}</div>
            <div className="stat-value">{stat.value}</div>
            <div className="stat-hint">{stat.hint}</div>
          </article>
        ))}
      </div>

      <div className="ops-grid">
        <section className="ops-panel traffic-panel">
          <div className="panel-heading">
            <div>
              <h3>24 小时流量趋势</h3>
              <span>按小时聚合，上行 + 下行</span>
            </div>
            <div className="chart-legend">
              <i />
              流量
            </div>
          </div>
          <div
            className="traffic-chart"
            role="img"
            aria-label="过去 24 小时流量柱状图"
          >
            {overview?.series.map((bucket, index) => {
              const total = bucket.bytesUp + bucket.bytesDown;
              const height = total ? Math.max(5, (total / chartMax) * 100) : 2;
              return (
                <div
                  className="traffic-column"
                  key={bucket.ts}
                  title={`${hourLabel(bucket.ts)} · ${fmtBytes(total)} · ${bucket.connections} 次连接`}
                >
                  <div className="traffic-track">
                    <div
                      className="traffic-fill"
                      style={{ height: `${height}%` }}
                    />
                  </div>
                  <span>
                    {index % 4 === 0 ? hourLabel(bucket.ts).slice(0, 2) : ""}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="ops-panel alert-panel">
          <div className="panel-heading">
            <div>
              <h3>需要处理</h3>
              <span>账号限制与节点异常</span>
            </div>
            <span
              className={`count-badge ${overview?.alerts.length ? "has-alerts" : ""}`}
            >
              {overview?.alerts.length || 0}
            </span>
          </div>
          <div className="alert-list">
            {overview?.alerts.length ? (
              overview.alerts.map((alert) => (
                <div
                  className={`alert-item alert-${alert.severity}`}
                  key={`${alert.kind}-${alert.id}`}
                >
                  <span className="alert-dot" />
                  <div>
                    <strong>{alert.title}</strong>
                    <span>{alert.detail}</span>
                  </div>
                  <em>
                    {alert.kind === "user"
                      ? "用户"
                      : alert.kind === "landing"
                        ? "落地机"
                        : "节点"}
                  </em>
                </div>
              ))
            ) : (
              <div className="all-clear">
                <span>✓</span>
                <div>
                  <strong>当前无告警</strong>
                  <small>用户限制和节点状态均正常</small>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="ops-grid bottom-grid">
        <section className="ops-panel">
          <div className="panel-heading">
            <div>
              <h3>用量最高的用户</h3>
              <span>累计流量排序</span>
            </div>
          </div>
          <div className="table-scroll">
            <table className="tbl compact-table">
              <thead>
                <tr>
                  <th>用户</th>
                  <th>状态</th>
                  <th>流量</th>
                  <th>连接</th>
                  <th>在线 IP</th>
                </tr>
              </thead>
              <tbody>
                {overview?.topUsers.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <strong>
                        {user.username || `用户 ${user.id.slice(0, 6)}`}
                      </strong>
                    </td>
                    <td>
                      <span
                        className={`pill pill-${user.accessSeverity}`}
                        title={user.accessReason}
                      >
                        {statusText(user.accessSeverity)}
                      </span>
                    </td>
                    <td>{fmtBytes(user.usedBytes, true)}</td>
                    <td>{fmtNumber(user.connections)}</td>
                    <td>
                      {user.activeIps} / {user.deviceLimit}
                    </td>
                  </tr>
                ))}
                {!overview?.topUsers.length && (
                  <tr>
                    <td colSpan={5} className="muted">
                      暂无用户用量。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="ops-panel">
          <div className="panel-heading">
            <div>
              <h3>节点流量</h3>
              <span>过去 24 小时</span>
            </div>
          </div>
          <div className="node-meter-list">
            {overview?.nodeTraffic.map((node) => {
              const bytes = node.bytesUp + node.bytesDown;
              const peak = Math.max(
                1,
                ...overview.nodeTraffic.map(
                  (item) => item.bytesUp + item.bytesDown,
                ),
              );
              return (
                <div className="node-meter" key={node.id}>
                  <div className="node-meter-head">
                    <div>
                      <strong>{node.id}</strong>
                      <span>
                        {node.region || "未标注"} ·{" "}
                        {node.health === "healthy"
                          ? "探测正常"
                          : node.health === "banned"
                            ? "已摘除"
                            : node.health === "degraded"
                              ? "探测降级"
                              : "等待检查"}{" "}
                        · {relTime(node.lastSeen)}
                      </span>
                    </div>
                    <div className="node-meter-value">
                      <strong>{fmtBytes(bytes, true)}</strong>
                      <span>{fmtNumber(node.connections)} 次</span>
                    </div>
                  </div>
                  <div className="meter-track">
                    <div
                      style={{
                        width: `${bytes ? Math.max(3, (bytes / peak) * 100) : 0}%`,
                      }}
                    />
                  </div>
                </div>
              );
            })}
            {!overview?.nodeTraffic.length && (
              <div className="muted">还没有节点数据。</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
