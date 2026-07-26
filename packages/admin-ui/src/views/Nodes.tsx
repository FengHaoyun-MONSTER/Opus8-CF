import { useEffect, useState } from "react";
import { api, type NodeRow } from "../api";
import { relTime, fmtTime, copy } from "../util";

export function Nodes() {
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    try {
      setNodes((await api.listNodes()).nodes);
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

  return (
    <div className="view">
      <div className="view-head">
        <h2>节点管理</h2>
        <button className="btn-ghost" onClick={() => void refresh()}>
          刷新
        </button>
      </div>

      {error && <div className="err">{error}</div>}

      {loading ? (
        <div className="muted">加载中…</div>
      ) : nodes.length === 0 ? (
        <div className="muted">
          还没有节点注册。CI 批量部署边缘节点后，节点会通过自注册接口出现在这里。
        </div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Node ID</th>
              <th>账号</th>
              <th>域名</th>
              <th>地区</th>
              <th>健康</th>
              <th>优选 IP</th>
              <th>心跳</th>
              <th>注册于</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.id}>
                <td className="mono" onClick={() => void copy(n.id)} title="点击复制完整 ID">
                  {n.id.slice(0, 8)}…
                </td>
                <td>{n.account_alias}</td>
                <td className="mono">{n.hostname || "—"}</td>
                <td>{n.region || "—"}</td>
                <td>
                  <span className={`pill pill-${n.health}`}>{n.health}</span>
                </td>
                <td className="mono">{n.preferred_ip || "—"}</td>
                <td className="muted">{relTime(n.last_seen)}</td>
                <td className="muted">{fmtTime(n.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
