import { useEffect, useState, type FormEvent } from "react";
import { api, type User, type UserActivity } from "../api";
import {
  copy,
  fmtBytes,
  fmtExpire,
  fmtTime,
  relTime,
  subUrlFor,
} from "../util";

const GIB = 1024 ** 3;

function accessLabel(user: User): string {
  if (user.access_state === "active") return "正常";
  if (user.access_state === "disabled") return "已停用";
  if (user.access_state === "expired") return "已过期";
  if (user.access_state === "traffic_quota_exceeded") return "流量耗尽";
  if (user.access_state === "active_ip_limit_reached") return "在线已满";
  if (user.access_state === "ip_churn_limit_reached") return "IP 已满";
  if (user.access_state === "traffic_near_quota") return "流量预警";
  return "即将到期";
}

function promptInteger(
  label: string,
  current: number,
  min: number,
  max: number,
): number | null {
  const raw = prompt(label, String(current));
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label}必须是 ${min} 到 ${max} 之间的整数`);
  }
  return value;
}

export function Users() {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "healthy" | "warning" | "danger"
  >("all");
  const [detailUser, setDetailUser] = useState<User | null>(null);
  const [activity, setActivity] = useState<UserActivity | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);

  const [username, setUsername] = useState("");
  const [durationDays, setDurationDays] = useState("30");
  const [unlock, setUnlock] = useState(false);
  const [nodeGroup, setNodeGroup] = useState("");
  const [deviceLimit, setDeviceLimit] = useState("2");
  const [ipLimit24h, setIpLimit24h] = useState("5");
  const [trafficLimitGb, setTrafficLimitGb] = useState("0");
  const [creating, setCreating] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      setUsers((await api.listUsers()).users);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError("");
    try {
      const group = nodeGroup
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const days = Number.parseInt(durationDays, 10);
      const devices = Number.parseInt(deviceLimit, 10);
      const dailyIps = Number.parseInt(ipLimit24h, 10);
      const quotaGb = Number(trafficLimitGb);
      if (!Number.isSafeInteger(devices) || devices < 1 || devices > 20) {
        throw new Error("同时在线 IP 必须是 1 到 20");
      }
      if (
        !Number.isSafeInteger(dailyIps) ||
        dailyIps < devices ||
        dailyIps > 100
      ) {
        throw new Error("24 小时 IP 上限必须不小于同时在线 IP，且不超过 100");
      }
      if (!Number.isFinite(quotaGb) || quotaGb < 0) {
        throw new Error("流量额度不能是负数");
      }
      await api.createUser({
        username: username || undefined,
        durationDays: Number.isFinite(days) && days > 0 ? days : undefined,
        unlock,
        nodeGroup: group.length ? group : undefined,
        deviceLimit: devices,
        ipLimit24h: dailyIps,
        trafficLimitBytes: Math.round(quotaGb * GIB),
      });
      setUsername("");
      setNodeGroup("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function remove(user: User) {
    if (!confirm(`删除用户 ${user.username || user.id}？此操作不可撤销。`))
      return;
    try {
      await api.deleteUser(user.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function toggleUnlock(user: User) {
    try {
      await api.updateUser(user.id, { unlock: !user.unlock });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function toggleEnabled(user: User) {
    try {
      await api.updateUser(user.id, { enabled: !user.enabled });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function configureLimits(user: User) {
    setError("");
    try {
      const devices = promptInteger(
        "同时在线公网 IP 上限",
        user.device_limit,
        1,
        20,
      );
      if (devices === null) return;
      const dailyIps = promptInteger(
        "24 小时不同公网 IP 上限",
        user.ip_limit_24h,
        devices,
        100,
      );
      if (dailyIps === null) return;
      const currentGb = user.traffic_limit_bytes
        ? user.traffic_limit_bytes / GIB
        : 0;
      const quotaRaw = prompt(
        "总流量额度（GB，0 表示不限量）",
        String(currentGb),
      );
      if (quotaRaw === null) return;
      const quotaGb = Number(quotaRaw);
      if (!Number.isFinite(quotaGb) || quotaGb < 0)
        throw new Error("流量额度不能是负数");
      await api.updateUser(user.id, {
        deviceLimit: devices,
        ipLimit24h: dailyIps,
        trafficLimitBytes: Math.round(quotaGb * GIB),
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function resetUsage(user: User) {
    if (!confirm(`清零 ${user.username || user.id} 的流量统计？`)) return;
    try {
      await api.resetUserUsage(user.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function resetLeases(user: User) {
    if (!confirm(`重置 ${user.username || user.id} 的在线及 24 小时 IP 记录？`))
      return;
    try {
      await api.resetUserLeases(user.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function copySub(user: User) {
    await copy(subUrlFor(user.sub_token));
    setCopied(user.id);
    setTimeout(() => setCopied(""), 1500);
  }

  async function openActivity(user: User) {
    setDetailUser(user);
    setActivity(null);
    setActivityLoading(true);
    try {
      setActivity(await api.userActivity(user.id));
    } catch (e) {
      setError((e as Error).message);
      setDetailUser(null);
    } finally {
      setActivityLoading(false);
    }
  }

  const normalizedQuery = query.trim().toLowerCase();
  const filteredUsers = users.filter((user) => {
    const matchesQuery =
      !normalizedQuery ||
      (user.username || "").toLowerCase().includes(normalizedQuery) ||
      user.uuid.toLowerCase().includes(normalizedQuery) ||
      user.id.toLowerCase().includes(normalizedQuery);
    const matchesStatus =
      statusFilter === "all" || user.access_severity === statusFilter;
    return matchesQuery && matchesStatus;
  });

  return (
    <div className="view users-view">
      <div className="view-head">
        <div>
          <h2>用户与防分享</h2>
          <div className="muted">
            按 UUID 统计流量，并限制同时在线及 24 小时公网 IP 数。
          </div>
        </div>
        <button
          className="btn-ghost"
          onClick={() => void refresh()}
          disabled={loading}
        >
          刷新
        </button>
      </div>

      <form className="create-bar user-create-bar" onSubmit={create}>
        <input
          placeholder="用户名（可选）"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          className="w-short"
          type="number"
          min="0"
          placeholder="天数"
          value={durationDays}
          onChange={(e) => setDurationDays(e.target.value)}
          title="有效天数，0 或空表示永久"
        />
        <input
          className="w-short"
          type="number"
          min="1"
          max="20"
          value={deviceLimit}
          onChange={(e) => setDeviceLimit(e.target.value)}
          title="同时在线公网 IP 上限"
        />
        <input
          className="w-short"
          type="number"
          min="1"
          max="100"
          value={ipLimit24h}
          onChange={(e) => setIpLimit24h(e.target.value)}
          title="24 小时不同公网 IP 上限"
        />
        <input
          className="w-short"
          type="number"
          min="0"
          step="0.1"
          value={trafficLimitGb}
          onChange={(e) => setTrafficLimitGb(e.target.value)}
          title="总流量额度 GB，0 表示不限量"
        />
        <input
          placeholder="节点组（逗号分隔，空=全部）"
          value={nodeGroup}
          onChange={(e) => setNodeGroup(e.target.value)}
        />
        <label className="chk">
          <input
            type="checkbox"
            checked={unlock}
            onChange={(e) => setUnlock(e.target.checked)}
          />
          AI 落地解锁
        </label>
        <button className="btn-primary" type="submit" disabled={creating}>
          {creating ? "创建中…" : "+ 新建用户"}
        </button>
      </form>
      <div className="field-hints muted">
        <span>在线 IP</span>
        <span>24h IP</span>
        <span>流量 GB（0=不限）</span>
      </div>

      {error && <div className="err">{error}</div>}

      <div className="user-toolbar">
        <div className="search-box">
          <span>⌕</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索用户名、UUID 或用户 ID"
          />
        </div>
        <div className="filter-pills">
          {(
            [
              ["all", "全部"],
              ["healthy", "正常"],
              ["warning", "需关注"],
              ["danger", "已受限"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              className={statusFilter === value ? "active" : ""}
              onClick={() => setStatusFilter(value)}
            >
              {label}
              <span>
                {value === "all"
                  ? users.length
                  : users.filter((user) => user.access_severity === value)
                      .length}
              </span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="muted">加载中…</div>
      ) : (
        <div className="table-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>用户</th>
                <th>UUID</th>
                <th>在线 / 限制</th>
                <th>24h IP</th>
                <th>流量</th>
                <th>连接</th>
                <th>AI 落地</th>
                <th>到期 / 状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((user) => {
                const used = user.bytes_up + user.bytes_down;
                const quota = user.traffic_limit_bytes;
                return (
                  <tr key={user.id}>
                    <td>
                      {user.username || <span className="muted">(无名)</span>}
                    </td>
                    <td className="mono">{user.uuid.slice(0, 8)}…</td>
                    <td>
                      <span
                        className={
                          user.active_ips >= user.device_limit
                            ? "pill pill-warning"
                            : "pill pill-healthy"
                        }
                      >
                        {user.active_ips} / {user.device_limit}
                      </span>
                    </td>
                    <td>
                      {user.recent_ips} / {user.ip_limit_24h}
                    </td>
                    <td
                      title={`上行 ${fmtBytes(user.bytes_up)} / 下行 ${fmtBytes(user.bytes_down)}`}
                    >
                      {fmtBytes(used)} / {quota ? fmtBytes(quota) : "不限"}
                    </td>
                    <td>{user.connections}</td>
                    <td>
                      <label className="switch-label">
                        <input
                          type="checkbox"
                          checked={user.unlock === 1}
                          onChange={() => void toggleUnlock(user)}
                        />
                        {user.unlock ? "允许" : "禁止"}
                      </label>
                    </td>
                    <td>
                      <span
                        className={`pill pill-${user.access_severity}`}
                        title={user.access_reason}
                      >
                        {accessLabel(user)}
                      </span>
                      <div
                        className="muted small-text"
                        title={user.access_reason}
                      >
                        {fmtExpire(user.expire_at)}
                      </div>
                    </td>
                    <td>
                      <div className="user-actions">
                        <button
                          className="btn-mini"
                          onClick={() => void openActivity(user)}
                        >
                          详情
                        </button>
                        <button
                          className="btn-mini"
                          onClick={() => void copySub(user)}
                        >
                          {copied === user.id ? "已复制" : "订阅"}
                        </button>
                        <button
                          className="btn-mini"
                          onClick={() => void toggleEnabled(user)}
                        >
                          {user.enabled ? "停用" : "启用"}
                        </button>
                        <button
                          className="btn-mini"
                          onClick={() => void configureLimits(user)}
                        >
                          限制
                        </button>
                        <button
                          className="btn-mini"
                          onClick={() => void resetLeases(user)}
                        >
                          重置设备
                        </button>
                        <button
                          className="btn-mini"
                          onClick={() => void resetUsage(user)}
                        >
                          清流量
                        </button>
                        <button
                          className="btn-danger"
                          onClick={() => void remove(user)}
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={9} className="muted">
                    {users.length ? "没有符合筛选条件的用户。" : "还没有用户。"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {detailUser && (
        <div className="drawer-backdrop" onClick={() => setDetailUser(null)}>
          <aside
            className="activity-drawer"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="drawer-head">
              <div>
                <span className="eyebrow">USER ACTIVITY</span>
                <h2>
                  {detailUser.username || `用户 ${detailUser.id.slice(0, 8)}`}
                </h2>
                <span className={`pill pill-${detailUser.access_severity}`}>
                  {detailUser.access_reason}
                </span>
              </div>
              <button
                className="drawer-close"
                onClick={() => setDetailUser(null)}
                aria-label="关闭"
              >
                ×
              </button>
            </div>

            {activityLoading ? (
              <div className="loading-state">正在读取连接活动…</div>
            ) : (
              activity && (
                <div className="drawer-content">
                  <div className="activity-summary">
                    <div>
                      <span>累计流量</span>
                      <strong>{fmtBytes(activity.user.usedBytes)}</strong>
                    </div>
                    <div>
                      <span>连接次数</span>
                      <strong>{activity.user.connections}</strong>
                    </div>
                    <div>
                      <span>在线 IP</span>
                      <strong>
                        {activity.user.activeIps} / {activity.user.deviceLimit}
                      </strong>
                    </div>
                    <div>
                      <span>24h IP</span>
                      <strong>
                        {activity.user.recentIps} / {activity.user.ipLimit24h}
                      </strong>
                    </div>
                  </div>

                  <section className="drawer-section">
                    <div className="drawer-section-title">
                      <h3>当前在线租约</h3>
                      <span>{activity.activeLeases.length} 个</span>
                    </div>
                    {activity.activeLeases.length ? (
                      <div className="activity-list">
                        {activity.activeLeases.map((lease) => (
                          <div
                            className="activity-row"
                            key={`${lease.fingerprint}-${lease.nodeId}`}
                          >
                            <div>
                              <strong className="mono">
                                {lease.fingerprint}
                              </strong>
                              <span>IP 指纹 · 不保存原始地址</span>
                            </div>
                            <div>
                              <strong>{lease.nodeId}</strong>
                              <span>
                                {relTime(lease.lastSeen)}活跃 ·{" "}
                                {fmtTime(lease.expiresAt)} 释放
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="empty-inline">当前没有在线设备。</div>
                    )}
                  </section>

                  <section className="drawer-section">
                    <div className="drawer-section-title">
                      <h3>24 小时 IP 指纹</h3>
                      <span>{activity.recentFingerprints.length} 个</span>
                    </div>
                    <div className="fingerprint-grid">
                      {activity.recentFingerprints.map((item) => (
                        <div
                          key={item.fingerprint}
                          className={
                            item.active ? "fingerprint active" : "fingerprint"
                          }
                        >
                          <strong className="mono">{item.fingerprint}</strong>
                          <span>
                            {item.active ? "在线" : relTime(item.lastSeen)}
                          </span>
                        </div>
                      ))}
                      {!activity.recentFingerprints.length && (
                        <div className="empty-inline">暂无记录。</div>
                      )}
                    </div>
                  </section>

                  <section className="drawer-section">
                    <div className="drawer-section-title">
                      <h3>节点用量</h3>
                    </div>
                    <div className="activity-list">
                      {activity.usageByNode.map((usage) => (
                        <div className="activity-row" key={usage.nodeId}>
                          <div>
                            <strong>{usage.nodeId}</strong>
                            <span>{relTime(usage.lastActive)}活跃</span>
                          </div>
                          <div className="align-right">
                            <strong>
                              {fmtBytes(usage.bytesUp + usage.bytesDown)}
                            </strong>
                            <span>{usage.connections} 次连接</span>
                          </div>
                        </div>
                      ))}
                      {!activity.usageByNode.length && (
                        <div className="empty-inline">暂无用量。</div>
                      )}
                    </div>
                  </section>

                  <div className="drawer-actions">
                    <button
                      className="btn-ghost"
                      onClick={() => void resetLeases(detailUser)}
                    >
                      重置设备/IP
                    </button>
                    <button
                      className="btn-ghost"
                      onClick={() => void resetUsage(detailUser)}
                    >
                      清零流量
                    </button>
                    <button
                      className={
                        detailUser.enabled ? "btn-danger" : "btn-primary"
                      }
                      onClick={() => void toggleEnabled(detailUser)}
                    >
                      {detailUser.enabled ? "立即停用账号" : "恢复账号"}
                    </button>
                  </div>
                </div>
              )
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
