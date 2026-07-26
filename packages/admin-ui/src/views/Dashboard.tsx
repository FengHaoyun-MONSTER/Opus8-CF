import { useEffect, useState } from "react";
import { api, type User, type NodeRow } from "../api";
import { relTime } from "../util";

interface Stat {
  label: string;
  value: number | string;
  hint?: string;
  tone: "a" | "b" | "c" | "d";
}

export function Dashboard() {
  const [users, setUsers] = useState<User[]>([]);
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [u, n] = await Promise.all([api.listUsers(), api.listNodes()]);
        setUsers(u.users);
        setNodes(n.nodes);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const now = Date.now();
  const activeUsers = users.filter((u) => u.enabled === 1 && (!u.expire_at || u.expire_at > now)).length;
  const healthyNodes = nodes.filter((n) => n.health === "healthy" && n.enabled === 1).length;

  const stats: Stat[] = [
    { label: "用户总数", value: users.length, tone: "a" },
    { label: "有效用户", value: activeUsers, hint: "启用中且未过期", tone: "b" },
    { label: "节点总数", value: nodes.length, tone: "c" },
    { label: "健康节点", value: healthyNodes, hint: `${nodes.length - healthyNodes} 个异常`, tone: "d" },
  ];

  if (loading) return <div className="muted">加载中…</div>;
  if (error) return <div className="err">{error}</div>;

  return (
    <div className="view">
      <h2>仪表盘</h2>
      <div className="stat-row">
        {stats.map((s) => (
          <div key={s.label} className={`stat stat-${s.tone}`}>
            <div className="stat-value">{s.value}</div>
            <div className="stat-label">{s.label}</div>
            {s.hint && <div className="stat-hint">{s.hint}</div>}
          </div>
        ))}
      </div>

      <h3>节点健康</h3>
      {nodes.length === 0 ? (
        <div className="muted">还没有节点注册。部署边缘节点后会自动出现在这里。</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>节点</th>
              <th>账号</th>
              <th>地区</th>
              <th>健康</th>
              <th>优选 IP</th>
              <th>最近心跳</th>
            </tr>
          </thead>
          <tbody>
            {nodes.slice(0, 8).map((n) => (
              <tr key={n.id}>
                <td className="mono">{n.hostname || n.id.slice(0, 8)}</td>
                <td>{n.account_alias}</td>
                <td>{n.region || "—"}</td>
                <td>
                  <span className={`pill pill-${n.health}`}>{n.health}</span>
                </td>
                <td className="mono">{n.preferred_ip || "—"}</td>
                <td className="muted">{relTime(n.last_seen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
