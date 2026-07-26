import { useState } from "react";
import { clearAuth, isLoggedIn, loadAuth, apiBase } from "./api";
import { Login } from "./views/Login";
import { Dashboard } from "./views/Dashboard";
import { Users } from "./views/Users";
import { Nodes } from "./views/Nodes";

type Tab = "dashboard" | "users" | "nodes";

export function App() {
  loadAuth();
  const [authed, setAuthed] = useState(isLoggedIn());
  const [tab, setTab] = useState<Tab>("dashboard");

  if (!authed) return <Login onLoggedIn={() => setAuthed(true)} />;

  const logout = () => {
    clearAuth();
    setAuthed(false);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Opus8<span className="brand-cf">-CF</span>
          <span className="brand-sub">控制台</span>
        </div>
        <nav className="tabs">
          <button className={tab === "dashboard" ? "active" : ""} onClick={() => setTab("dashboard")}>
            仪表盘
          </button>
          <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>
            用户
          </button>
          <button className={tab === "nodes" ? "active" : ""} onClick={() => setTab("nodes")}>
            节点
          </button>
        </nav>
        <div className="topright">
          <span className="api-host" title={apiBase()}>
            {apiBase().replace(/^https?:\/\//, "")}
          </span>
          <button className="btn-ghost" onClick={logout}>
            退出
          </button>
        </div>
      </header>
      <main className="content">
        {tab === "dashboard" && <Dashboard />}
        {tab === "users" && <Users />}
        {tab === "nodes" && <Nodes />}
      </main>
    </div>
  );
}
