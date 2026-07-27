import { useEffect, useState, type FormEvent } from "react";
import { api, type User } from "../api";
import { fmtExpire, subUrlFor, copy } from "../util";

const GIB = 1024 ** 3;

function fmtBytes(value: number): string {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index >= 3 ? 2 : 1)} ${units[index]}`;
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
      const group = nodeGroup.split(",").map((s) => s.trim()).filter(Boolean);
      const days = Number.parseInt(durationDays, 10);
      const devices = Number.parseInt(deviceLimit, 10);
      const dailyIps = Number.parseInt(ipLimit24h, 10);
      const quotaGb = Number(trafficLimitGb);
      if (!Number.isSafeInteger(devices) || devices < 1 || devices > 20) {
        throw new Error("同时在线 IP 必须是 1 到 20");
      }
      if (!Number.isSafeInteger(dailyIps) || dailyIps < devices || dailyIps > 100) {
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
    if (!confirm(`删除用户 ${user.username || user.id}？此操作不可撤销。`)) return;
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
      const devices = promptInteger("同时在线公网 IP 上限", user.device_limit, 1, 20);
      if (devices === null) return;
      const dailyIps = promptInteger("24 小时不同公网 IP 上限", user.ip_limit_24h, devices, 100);
      if (dailyIps === null) return;
      const currentGb = user.traffic_limit_bytes ? user.traffic_limit_bytes / GIB : 0;
      const quotaRaw = prompt("总流量额度（GB，0 表示不限量）", String(currentGb));
      if (quotaRaw === null) return;
      const quotaGb = Number(quotaRaw);
      if (!Number.isFinite(quotaGb) || quotaGb < 0) throw new Error("流量额度不能是负数");
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
    if (!confirm(`重置 ${user.username || user.id} 的在线及 24 小时 IP 记录？`)) return;
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

  return (
    <div className="view users-view">
      <div className="view-head">
        <div>
          <h2>用户与防分享</h2>
          <div className="muted">按 UUID 统计流量，并限制同时在线及 24 小时公网 IP 数。</div>
        </div>
      </div>

      <form className="create-bar user-create-bar" onSubmit={create}>
        <input placeholder="用户名（可选）" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input className="w-short" type="number" min="0" placeholder="天数" value={durationDays}
          onChange={(e) => setDurationDays(e.target.value)} title="有效天数，0 或空表示永久" />
        <input className="w-short" type="number" min="1" max="20" value={deviceLimit}
          onChange={(e) => setDeviceLimit(e.target.value)} title="同时在线公网 IP 上限" />
        <input className="w-short" type="number" min="1" max="100" value={ipLimit24h}
          onChange={(e) => setIpLimit24h(e.target.value)} title="24 小时不同公网 IP 上限" />
        <input className="w-short" type="number" min="0" step="0.1" value={trafficLimitGb}
          onChange={(e) => setTrafficLimitGb(e.target.value)} title="总流量额度 GB，0 表示不限量" />
        <input placeholder="节点组（逗号分隔，空=全部）" value={nodeGroup}
          onChange={(e) => setNodeGroup(e.target.value)} />
        <label className="chk">
          <input type="checkbox" checked={unlock} onChange={(e) => setUnlock(e.target.checked)} />
          AI 落地解锁
        </label>
        <button className="btn-primary" type="submit" disabled={creating}>
          {creating ? "创建中…" : "+ 新建用户"}
        </button>
      </form>
      <div className="field-hints muted">
        <span>在线 IP</span><span>24h IP</span><span>流量 GB（0=不限）</span>
      </div>

      {error && <div className="err">{error}</div>}

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
              {users.map((user) => {
                const used = user.bytes_up + user.bytes_down;
                const quota = user.traffic_limit_bytes;
                return (
                  <tr key={user.id}>
                    <td>{user.username || <span className="muted">(无名)</span>}</td>
                    <td className="mono">{user.uuid.slice(0, 8)}…</td>
                    <td>
                      <span className={user.active_ips > user.device_limit ? "pill pill-banned" : "pill pill-healthy"}>
                        {user.active_ips} / {user.device_limit}
                      </span>
                    </td>
                    <td>{user.recent_ips} / {user.ip_limit_24h}</td>
                    <td title={`上行 ${fmtBytes(user.bytes_up)} / 下行 ${fmtBytes(user.bytes_down)}`}>
                      {fmtBytes(used)} / {quota ? fmtBytes(quota) : "不限"}
                    </td>
                    <td>{user.connections}</td>
                    <td>
                      <label className="switch-label">
                        <input type="checkbox" checked={user.unlock === 1}
                          onChange={() => void toggleUnlock(user)} />
                        {user.unlock ? "允许" : "禁止"}
                      </label>
                    </td>
                    <td>
                      <button className={`status-button pill ${user.enabled ? "pill-healthy" : "pill-banned"}`}
                        onClick={() => void toggleEnabled(user)}>
                        {user.enabled ? "启用" : "停用"}
                      </button>
                      <div className="muted small-text">{fmtExpire(user.expire_at)}</div>
                    </td>
                    <td>
                      <div className="user-actions">
                        <button className="btn-mini" onClick={() => void copySub(user)}>
                          {copied === user.id ? "已复制" : "订阅"}
                        </button>
                        <button className="btn-mini" onClick={() => void configureLimits(user)}>限制</button>
                        <button className="btn-mini" onClick={() => void resetLeases(user)}>重置设备</button>
                        <button className="btn-mini" onClick={() => void resetUsage(user)}>清流量</button>
                        <button className="btn-danger" onClick={() => void remove(user)}>删除</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {users.length === 0 && (
                <tr><td colSpan={9} className="muted">还没有用户。</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
