import { FormEvent, useEffect, useState } from "react";

import { AgentsPage } from "./pages/agents-page.js";
import { SessionPage } from "./pages/session-page.js";
import { SessionsPage } from "./pages/sessions-page.js";

type Route = { page: "agents" } | { page: "sessions" } | { page: "session"; id: string };

const currentRoute = (): Route => {
  const match = window.location.pathname.match(/^\/sessions\/([^/]+)$/);
  if (match?.[1] !== undefined) return { page: "session", id: decodeURIComponent(match[1]) };
  if (window.location.pathname === "/sessions") return { page: "sessions" };
  return { page: "agents" };
};
export const App = () => {
  const [token, setToken] = useState(() => sessionStorage.getItem("apiToken"));
  const [route, setRoute] = useState<Route>(currentRoute);

  useEffect(() => {
    const onPopState = () => setRoute(currentRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = (path: string) => {
    window.history.pushState({}, "", path);
    setRoute(currentRoute());
  };

  if (token === null) {
    return <TokenGate onSave={(value) => {
      sessionStorage.setItem("apiToken", value);
      setToken(value);
    }} />;
  }

  return (
    <div className="shell">
      <header className="topbar">
        <button className="wordmark" onClick={() => navigate("/agents")}>REMOTE / AGENT</button>
        <nav aria-label="主导航">
          <button aria-current={route.page === "agents" ? "page" : undefined} onClick={() => navigate("/agents")}>Agent</button>
          <button aria-current={route.page !== "agents" ? "page" : undefined} onClick={() => navigate("/sessions")}>Session</button>
        </nav>
        <button className="quiet-button" onClick={() => {
          sessionStorage.removeItem("apiToken");
          setToken(null);
        }}>断开</button>
      </header>
      <main>
        {route.page === "agents" ? <AgentsPage /> : null}
        {route.page === "sessions" ? <SessionsPage navigate={navigate} /> : null}
        {route.page === "session" ? <SessionPage sessionId={route.id} /> : null}
      </main>
    </div>
  );
};

const TokenGate = ({ onSave }: { onSave(token: string): void }) => {
  const [value, setValue] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const token = value.trim();
    if (token !== "") onSave(token);
  };

  return (
    <main className="token-gate">
      <section className="token-panel" aria-labelledby="token-title">
        <p className="eyebrow">REMOTE AGENT SERVER / 连接认证</p>
        <h1 id="token-title">连接 Remote Agent</h1>
        <p className="lede">输入服务器 API Token。凭证仅保留在当前浏览器会话中。</p>
        <form onSubmit={submit}>
          <label htmlFor="api-token">API Token</label>
          <input id="api-token" type="password" autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} autoFocus />
          <button className="primary-button" type="submit">进入管理台</button>
        </form>
      </section>
    </main>
  );
};
