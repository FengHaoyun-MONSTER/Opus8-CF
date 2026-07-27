import { useEffect, useState, type FormEvent } from "react";
import { api, type User } from "../api";
import { fmtExpire, subUrlFor, copy } from "../util";

export function Users() {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState("");

  // 建用户表单
  const [username, setUsername] = useState("");
  const [durationDays, setDurationDays] = useState("30");
  const [unlock, setUnlock] = useState(false);
  const [nodeGroup, setNodeGroup] = useState("");
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
      const days = parseInt(durationDays, 10);
      await api.createUser({
        username: username || undefined,
        durationDays: Number.isFinite(days) && days > 0 ? days : undefined,
        unlock,
        nodeGroup: group.length ? group : undefined,
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

  async function remove(u: User) {
    if (!confirm(`删除用户 ${u.username || u.id}？此操作不可撤销。`)) return;
    try {
      await api.deleteUser(u.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function toggleUnlock(u: User) {
    setError("");
    try {
      await api.updateUser(u.id, { unlock: !u.unlock });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function copySub(u: User) {
    await copy(subUrlFor(u.sub_token));
    setCopied(u.id);
    setTimeout(() => setCopied(""), 1500);
  }

  return (
    <div className="view">
      <h2>用户管理</h2>

      <form className="create-bar" onSubmit={create}>
        <input placeholder="用户名(可选)" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input
          className="w-short"
          type="number"
          min="0"
          placeholder="天数"
          value={durationDays}
          onChange={(e) => setDurationDays(e.target.value)}
          title="有效天数，0/空=永久"
        />
        <input
          placeholder="节点组(逗号分隔，空=全部)"
          value={nodeGroup}
          onChange={(e) => setNodeGroup(e.target.value)}
        />
        <label className="chk">
          <input type="checkbox" checked={unlock} onChange={(e) => setUnlock(e.target.checked)} />
          解锁套餐
        </label>
        <button className="btn-primary" type="submit" disabled={creating}>
          {creating ? "创建中…" : "+ 新建用户"}
        </button>
      </form>

      {error && <div className="err">{error}</div>}

      {loading ? (
        <div className="muted">加载中…</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>用户名</th>
              <th>UUID</th>
              <th>解锁</th>
              <th>到期</th>
              <th>状态</th>
              <th>订阅</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.username || <span className="muted">(无名)</span>}</td>
                <td className="mono">{u.uuid.slice(0, 8)}…</td>
                <td>
                  <label className="switch-label" title="控制该用户是否允许使用落地机">
                    <input
                      type="checkbox"
                      checked={u.unlock === 1}
                      onChange={() => void toggleUnlock(u)}
                    />
                    {u.unlock ? "允许" : "禁止"}
                  </label>
                </td>
                <td>{fmtExpire(u.expire_at)}</td>
                <td>
                  <span className={`pill ${u.enabled ? "pill-healthy" : "pill-banned"}`}>
                    {u.enabled ? "启用" : "停用"}
                  </span>
                </td>
                <td>
                  <button className="btn-mini" onClick={() => copySub(u)}>
                    {copied === u.id ? "已复制" : "复制链接"}
                  </button>
                </td>
                <td>
                  <button className="btn-danger" onClick={() => remove(u)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  还没有用户，用上面的表单创建第一个。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
