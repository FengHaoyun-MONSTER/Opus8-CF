import { useState, type FormEvent } from "react";
import { login, loadAuth } from "../api";

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const saved = loadAuth();
  const [base, setBase] = useState(saved.base || "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await login(base, password);
      onLoggedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          Opus8<span className="brand-cf">-CF</span>
        </div>
        <p className="login-tip">分散节点 · 统一控制</p>

        <label>控制面地址</label>
        <input
          type="url"
          placeholder="https://api.你的域名"
          value={base}
          onChange={(e) => setBase(e.target.value)}
          required
        />

        <label>管理员密码</label>
        <input
          type="password"
          placeholder="ADMIN_PASSWORD"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        {error && <div className="err">{error}</div>}

        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}
