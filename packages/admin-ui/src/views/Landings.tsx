import { useEffect, useState, type FormEvent } from "react";
import { api, type Landing, type LandingInput } from "../api";
import { fmtTime } from "../util";

interface FormState {
  name: string;
  hostname: string;
  port: string;
  username: string;
  password: string;
  region: string;
  priority: string;
  matchHosts: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  hostname: "",
  port: "40008",
  username: "",
  password: "",
  region: "",
  priority: "100",
  matchHosts: "",
  enabled: true,
};

function splitHosts(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((host) => host.trim())
    .filter(Boolean);
}

function formFor(landing: Landing): FormState {
  return {
    name: landing.name,
    hostname: landing.hostname,
    port: String(landing.port),
    username: "",
    password: "",
    region: landing.region || "",
    priority: String(landing.priority),
    matchHosts: landing.matchHosts.join("\n"),
    enabled: landing.enabled,
  };
}

export function Landings() {
  const [landings, setLandings] = useState<Landing[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refresh() {
    setLoading(true);
    try {
      setLandings((await api.listLandings()).landings);
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

  function patch<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function resetForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  function edit(landing: Landing) {
    setEditingId(landing.id);
    setForm(formFor(landing));
    setError("");
    setNotice("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const input: LandingInput = {
        name: form.name,
        hostname: form.hostname,
        port: Number(form.port),
        region: form.region,
        priority: Number(form.priority),
        matchHosts: splitHosts(form.matchHosts),
        enabled: form.enabled,
      };
      if (!editingId || form.username || form.password) {
        input.username = form.username;
        input.password = form.password;
      }
      if (editingId) {
        await api.updateLanding(editingId, input);
        setNotice("落地机配置已更新，节点会在约 60 秒内取得新配置。");
      } else {
        await api.createLanding(input);
        setNotice("落地机已创建，节点会在约 60 秒内取得新配置。");
      }
      resetForm();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function toggle(landing: Landing) {
    setError("");
    setNotice("");
    try {
      await api.updateLanding(landing.id, { enabled: !landing.enabled });
      setNotice(`${landing.name} 已${landing.enabled ? "停用" : "启用"}。`);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function test(landing: Landing) {
    setTestingId(landing.id);
    setError("");
    setNotice("");
    try {
      const result = await api.testLanding(landing.id);
      setNotice(`${landing.name} 连通成功，完整 SOCKS5 握手耗时 ${result.latencyMs} ms。`);
    } catch (e) {
      setError(`${landing.name} 测试失败：${(e as Error).message}`);
    } finally {
      setTestingId("");
      await refresh();
    }
  }

  async function remove(landing: Landing) {
    if (!confirm(`删除落地机“${landing.name}”？此操作不可撤销。`)) return;
    setError("");
    setNotice("");
    try {
      await api.deleteLanding(landing.id);
      if (editingId === landing.id) resetForm();
      setNotice(`${landing.name} 已删除。`);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="view landings-view">
      <div className="view-head">
        <div>
          <h2>落地机</h2>
          <div className="muted">
            配置多台带用户名和密码的 SOCKS5 落地机，并按负责域名和优先级自动选择、失败切换。
          </div>
        </div>
        <button className="btn-ghost" onClick={() => void refresh()} disabled={loading || saving}>
          刷新
        </button>
      </div>

      <form className="landing-form" onSubmit={(event) => void save(event)}>
        <div className="landing-form-title">
          <strong>{editingId ? "编辑落地机" : "新增落地机"}</strong>
          {editingId && (
            <button className="btn-ghost" type="button" onClick={resetForm}>
              取消编辑
            </button>
          )}
        </div>
        <div className="landing-grid">
          <label>
            名称
            <input required maxLength={64} value={form.name} onChange={(e) => patch("name", e.target.value)} placeholder="例如：新加坡主落地" />
          </label>
          <label>
            地区
            <input maxLength={32} value={form.region} onChange={(e) => patch("region", e.target.value)} placeholder="SG / HK / US" />
          </label>
          <label className="span-2">
            主机名或 IP
            <input required value={form.hostname} onChange={(e) => patch("hostname", e.target.value)} placeholder="landing.example.com 或 203.0.113.10" />
          </label>
          <label>
            端口
            <input required type="number" min={1} max={65535} value={form.port} onChange={(e) => patch("port", e.target.value)} />
          </label>
          <label>
            优先级
            <input required type="number" min={1} max={1000} value={form.priority} onChange={(e) => patch("priority", e.target.value)} />
            <small>数字越小越优先</small>
          </label>
          <label>
            用户名
            <input
              required={!editingId}
              autoComplete="off"
              value={form.username}
              onChange={(e) => patch("username", e.target.value)}
              placeholder={editingId ? "留空则保持原值" : "SOCKS5 用户名"}
            />
          </label>
          <label>
            密码
            <input
              required={!editingId}
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => patch("password", e.target.value)}
              placeholder={editingId ? "留空则保持原值" : "SOCKS5 密码"}
            />
          </label>
          <label className="span-2">
            负责域名（一行一个）
            <textarea
              value={form.matchHosts}
              onChange={(e) => patch("matchHosts", e.target.value)}
              spellCheck={false}
              placeholder={"留空 = 默认落地和故障兜底\n也可填写 chatgpt.com、openai.com"}
            />
            <small>相同域名可配置多台，系统按优先级依次尝试。</small>
          </label>
          <label className="landing-enabled">
            <input type="checkbox" checked={form.enabled} onChange={(e) => patch("enabled", e.target.checked)} />
            创建后立即启用
          </label>
        </div>
        <button className="btn-primary" type="submit" disabled={saving}>
          {saving ? "保存中…" : editingId ? "保存修改" : "+ 新增落地机"}
        </button>
      </form>

      {error && <div className="err">{error}</div>}
      {notice && <div className="ok">{notice}</div>}

      <div className="landing-help">
        <strong>选择规则：</strong>
        解锁用户访问“落地分流”清单中的域名时，优先使用负责该域名的落地机；留空负责域名的配置是默认落地。
        同一批候选按优先级从小到大尝试，一台连接失败会自动切换下一台。未开启解锁的用户不会取得落地权限。
      </div>

      {loading ? (
        <div className="muted">加载中…</div>
      ) : landings.length === 0 ? (
        <div className="empty-card">尚未配置落地机。新增后无需重新部署节点。</div>
      ) : (
        <div className="landing-list">
          {landings.map((landing) => (
            <article className={`landing-card ${landing.enabled ? "" : "landing-disabled"}`} key={landing.id}>
              <div className="landing-card-head">
                <div>
                  <strong>{landing.name}</strong>
                  {landing.region && <span className="landing-region">{landing.region}</span>}
                </div>
                <span className={`pill pill-${landing.health === "unhealthy" ? "banned" : landing.health}`}>
                  {landing.health === "healthy" ? "健康" : landing.health === "unhealthy" ? "异常" : "未测试"}
                </span>
              </div>
              <div className="landing-address mono">{landing.hostname}:{landing.port}</div>
              <div className="landing-meta">
                <span>用户：{landing.username}</span>
                <span>优先级：{landing.priority}</span>
                <span>{landing.enabled ? "已启用" : "已停用"}</span>
                {landing.lastChecked && <span>检测：{fmtTime(landing.lastChecked)}</span>}
              </div>
              <div className="landing-hosts">
                {landing.matchHosts.length === 0
                  ? <span className="pill pill-degraded">默认 / 故障兜底</span>
                  : landing.matchHosts.map((host) => <span className="host-chip mono" key={host}>{host}</span>)}
              </div>
              {landing.lastError && <div className="landing-last-error">{landing.lastError}</div>}
              <div className="landing-actions">
                <button className="btn-mini" onClick={() => void test(landing)} disabled={testingId === landing.id}>
                  {testingId === landing.id ? "测试中…" : "连通测试"}
                </button>
                <button className="btn-ghost" onClick={() => edit(landing)}>编辑</button>
                <button className="btn-ghost" onClick={() => void toggle(landing)}>
                  {landing.enabled ? "停用" : "启用"}
                </button>
                <button className="btn-danger" onClick={() => void remove(landing)}>删除</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
