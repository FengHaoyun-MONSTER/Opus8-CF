import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type ComplianceStatus,
  type OperationsOverview,
} from "../api";
import { fmtBytes, fmtNumber, relTime } from "../util";

interface Stat {
  label: string;
  value: string;
  hint: string;
  tone: "a" | "b" | "c" | "d" | "e" | "f";
}

type AlertFilter = "all" | "danger" | "warning";
type AlertView = "current" | "history";
type Alert = OperationsOverview["alerts"][number];

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

function alertKindText(kind: Alert["kind"]): string {
  if (kind === "user") return "用户";
  if (kind === "landing") return "落地机";
  if (kind === "optimized_ip") return "优选 IP";
  return "节点";
}

function alertTarget(kind: Alert["kind"]): string {
  if (kind === "user") return "#users";
  if (kind === "landing") return "#landings";
  return "#nodes";
}

export function Dashboard() {
  const [overview, setOverview] = useState<OperationsOverview | null>(null);
  const [compliance, setCompliance] = useState<ComplianceStatus | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [alertFilter, setAlertFilter] = useState<AlertFilter>("all");
  const [alertView, setAlertView] = useState<AlertView>("current");

  const refresh = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    try {
      const [overviewResponse, complianceResponse] = await Promise.all([
        api.operationsOverview(),
        api.complianceStatus().catch(() => null),
      ]);
      setOverview(overviewResponse);
      setCompliance(complianceResponse);
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
  const filteredAlerts = useMemo(
    () =>
      (overview?.alerts || []).filter(
        (alert) =>
          alertFilter === "all" || alert.severity === alertFilter,
      ),
    [overview, alertFilter],
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
          hint: `${summary.attentionUsers} 个需要关注`,
          tone: "c",
        },
        {
          label: "严重告警",
          value: String(summary.dangerAlerts),
          hint: `${summary.warningAlerts} 个一般告警`,
          tone: "d",
        },
        {
          label: "边缘节点",
          value: `${summary.healthyNodes} / ${summary.totalNodes}`,
          hint: overview
            ? `优选覆盖 ${overview.optimizedIp.activeNodes}/${overview.optimizedIp.eligibleNodes}`
            : "健康 / 总数",
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
            连接、流量、防分享限制、节点与出口健康状态，每 30 秒自动更新。
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
      {compliance &&
        (compliance.proxyProvisioningAllowed ? (
          <div className="ok">
            Cloudflare 书面许可门禁已通过；新增用户与受控节点部署可用。
          </div>
        ) : (
          <div className="err">
            合规门禁为失败关闭：新增用户、扩容、节点注册、落地能力扩展与优选 IP 发布已锁定。
            现有节点和订阅不会被系统自动删除。
          </div>
        ))}

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
          <div className="panel-heading alert-heading">
            <div>
              <h3>异常告警中心</h3>
              <span>严重告警优先，点击“处理”进入对应页面</span>
            </div>
            <span
              className={`count-badge ${overview?.alerts.length ? "has-alerts" : ""}`}
            >
              {overview?.alerts.length || 0}
            </span>
          </div>
          <div className="alert-mode-bar">
            <button
              className={alertView === "current" ? "active" : ""}
              onClick={() => setAlertView("current")}
            >
              当前告警
            </button>
            <button
              className={alertView === "history" ? "active" : ""}
              onClick={() => setAlertView("history")}
            >
              事件历史 {overview?.alertIncidents.length || 0}
            </button>
            <span>D1 状态事件 · KV 写入 0</span>
          </div>
          {alertView === "current" && (
            <div className="alert-filter-bar">
              {(
                [
                  ["all", "全部", overview?.alerts.length || 0],
                  ["danger", "严重", summary?.dangerAlerts || 0],
                  ["warning", "一般", summary?.warningAlerts || 0],
                ] as const
              ).map(([value, label, count]) => (
                <button
                  key={value}
                  className={alertFilter === value ? "active" : ""}
                  onClick={() => setAlertFilter(value)}
                >
                  {label} {count}
                </button>
              ))}
            </div>
          )}
          <div className={`alert-list alert-list-${alertView}`}>
            {alertView === "history" ? (
              overview?.alertIncidents.length ? (
                overview.alertIncidents.map((incident) => (
                  <div
                    className={`alert-item alert-${incident.severity} incident-${incident.status}`}
                    key={incident.key}
                  >
                    <span className="alert-dot" />
                    <div>
                      <strong>{incident.title}</strong>
                      <span>
                        {incident.status === "open" ? "处理中" : "已恢复"} ·
                        首次 {relTime(incident.firstSeen)} · 最后变化{" "}
                        {relTime(incident.lastChanged)}
                        {incident.occurrenceCount > 1
                          ? ` · 复发/升级 ${incident.occurrenceCount - 1} 次`
                          : ""}
                      </span>
                    </div>
                    <div className="alert-tail">
                      <em>{alertKindText(incident.kind)}</em>
                      <span className={`incident-state ${incident.status}`}>
                        {incident.status === "open" ? "开启" : "恢复"}
                      </span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="filtered-clear">尚无告警事件历史</div>
              )
            ) : (
              <>
                {filteredAlerts.length ? (
                  filteredAlerts.map((alert) => (
                    <div
                      className={`alert-item alert-${alert.severity}`}
                      key={`${alert.kind}-${alert.id}`}
                    >
                      <span className="alert-dot" />
                      <div>
                        <strong>{alert.title}</strong>
                        <span>{alert.detail}</span>
                      </div>
                      <div className="alert-tail">
                        <em>{alertKindText(alert.kind)}</em>
                        <a href={alertTarget(alert.kind)}>处理</a>
                      </div>
                    </div>
                  ))
                ) : overview?.alerts.length ? (
                  <div className="filtered-clear">
                    当前筛选条件下没有告警
                  </div>
                ) : (
                  <div className="all-clear">
                    <span>✓</span>
                    <div>
                      <strong>当前无告警</strong>
                      <small>用户、节点、优选 IP 和落地机状态均正常</small>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      </div>

      <div className="ops-grid bottom-grid">
        <section className="ops-panel">
          <div className="panel-heading">
            <div>
              <h3>用量最高的用户</h3>
              <span>按累计流量排序</span>
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
