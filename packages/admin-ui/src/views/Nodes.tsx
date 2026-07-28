import { useEffect, useState } from "react";
import { api, type NodeRow } from "../api";
import { relTime, fmtTime, copy } from "../util";

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
        <div>
          <h2>节点管理</h2>
          <div className="muted">
            每 10 分钟执行真实 VLESS 直连和落地/WARP 探测；连续 3
            次直连失败自动摘除，连续 2 次成功自动恢复。
          </div>
        </div>
        <button className="btn-ghost" onClick={() => void refresh()}>
          刷新
        </button>
      </div>

      {error && <div className="err">{error}</div>}

      {loading ? (
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
                    <div className="muted">
                      {node.region || "未标注"}
                      {node.preferred_ip
                        ? ` · 优选 ${node.preferred_ip}`
                        : ""}
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
                      <div
                        className="muted"
                        title={node.health_last_error}
                      >
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
