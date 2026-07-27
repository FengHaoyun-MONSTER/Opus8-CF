import { useEffect, useMemo, useState } from "react";
import { api, type UnlockHostsConfig } from "../api";
import { fmtTime } from "../util";

function splitHosts(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((host) => host.trim())
    .filter(Boolean);
}

export function Routes() {
  const [config, setConfig] = useState<UnlockHostsConfig | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const count = useMemo(() => splitHosts(text).length, [text]);

  async function refresh() {
    setLoading(true);
    try {
      const next = await api.getUnlockHosts();
      setConfig(next);
      setText(next.hosts.join("\n"));
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

  async function save() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const next = await api.putUnlockHosts(splitHosts(text));
      setConfig(next);
      setText(next.hosts.join("\n"));
      setNotice("已保存。节点会在约 60 秒内自动取得新规则，无需重新部署。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    if (!confirm("恢复代码仓库中的默认落地域名清单？当前自定义清单会被覆盖。")) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const next = await api.resetUnlockHosts();
      setConfig(next);
      setText(next.hosts.join("\n"));
      setNotice("已恢复默认清单，节点会在约 60 秒内自动更新。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="view routes-view">
      <div className="view-head">
        <div>
          <h2>落地分流</h2>
          <div className="muted">
            命中清单且用户开启“解锁”的流量走 SOCKS5 落地，其余流量走 Cloudflare 直出。
          </div>
        </div>
        <button className="btn-ghost" onClick={() => void refresh()} disabled={loading || saving}>
          刷新
        </button>
      </div>

      <div className="route-meta">
        <span className="pill pill-healthy">{count} 个域名</span>
        <span className="muted">
          来源：{config?.source === "custom" ? "后台自定义" : "代码默认"}
          {config?.updatedAt ? ` · 更新于 ${fmtTime(config.updatedAt)}` : ""}
        </span>
      </div>

      <label className="route-editor-label" htmlFor="unlock-hosts">
        一行一个根域名；不要填写协议、端口、路径或通配符
      </label>
      <textarea
        id="unlock-hosts"
        className="route-editor mono"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        disabled={loading || saving}
        placeholder={"openai.com\nchatgpt.com\nanthropic.com"}
      />

      {error && <div className="err">{error}</div>}
      {notice && <div className="ok">{notice}</div>}

      <div className="route-actions">
        <button className="btn-primary" onClick={() => void save()} disabled={loading || saving}>
          {saving ? "保存中…" : "保存并下发"}
        </button>
        <button className="btn-ghost" onClick={() => void reset()} disabled={loading || saving}>
          恢复代码默认值
        </button>
      </div>

      <div className="route-tip">
        建议只添加确实需要特定出口地区或解锁能力的域名。添加过于宽泛的根域名会增加落地机流量和带宽消耗。
      </div>
    </div>
  );
}
