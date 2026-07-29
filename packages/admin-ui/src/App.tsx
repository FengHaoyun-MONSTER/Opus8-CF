import { useEffect, useState } from "react";
import { clearAuth, isLoggedIn, loadAuth, apiBase } from "./api";
import { Login } from "./views/Login";
import { Dashboard } from "./views/Dashboard";
import { Users } from "./views/Users";
import { Nodes } from "./views/Nodes";
import { Routes } from "./views/Routes";
import { Landings } from "./views/Landings";

type Tab = "dashboard" | "users" | "nodes" | "routes" | "landings";
const TABS: Tab[] = ["dashboard", "users", "nodes", "routes", "landings"];

function initialTab(): Tab {
  const value = window.location.hash.replace(/^#/, "") as Tab;
  return TABS.includes(value) ? value : "dashboard";
}

export function App() {
  loadAuth();
  const [authed, setAuthed] = useState(isLoggedIn());
  const [tab, setTab] = useState<Tab>(initialTab);

  useEffect(() => {
    const onHashChange = () => setTab(initialTab());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const selectTab = (value: Tab) => {
    window.history.replaceState(null, "", `#${value}`);
    setTab(value);
  };

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
          <span className="brand-sub">运营控制台</span>
        </div>
        <nav className="tabs">
          <button
            className={tab === "dashboard" ? "active" : ""}
            onClick={() => selectTab("dashboard")}
          >
            运营总览
          </button>
          <button
            className={tab === "users" ? "active" : ""}
            onClick={() => selectTab("users")}
          >
            用户
          </button>
          <button
            className={tab === "nodes" ? "active" : ""}
            onClick={() => selectTab("nodes")}
          >
            节点
          </button>
          <button
            className={tab === "routes" ? "active" : ""}
            onClick={() => selectTab("routes")}
          >
            落地分流
          </button>
          <button
            className={tab === "landings" ? "active" : ""}
            onClick={() => selectTab("landings")}
          >
            落地机
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
        {tab === "routes" && <Routes />}
        {tab === "landings" && <Landings />}
      </main>
    </div>
  );
}
