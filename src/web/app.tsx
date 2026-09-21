import { Component, lazy, Suspense, type ErrorInfo, type FormEvent, type ReactNode, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router";

import { AppShellLayout } from "./components/app-shell.js";
import { Button } from "./components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card.js";
import { Input } from "./components/ui/input.js";
import { Field, FieldGroup, FieldLabel } from "./components/ui/field.js";
import { I18nProvider, useI18n } from "./i18n.js";
import { API_TOKEN_INVALID_EVENT, verifyApiToken } from "./api.js";
const agentPages = () => import("./pages/agent-pages.js");
const AgentCreatePage = lazy(async () => ({ default: (await agentPages()).AgentCreatePage }));
const AgentDetailLayout = lazy(async () => ({ default: (await agentPages()).AgentDetailLayout }));
const AgentListPage = lazy(async () => ({ default: (await agentPages()).AgentListPage }));
const AgentOverviewPage = lazy(async () => ({ default: (await agentPages()).AgentOverviewPage }));
const AgentSettingsPage = lazy(async () => ({ default: (await agentPages()).AgentSettingsPage }));
const AgentSkillsPage = lazy(async () => ({ default: (await agentPages()).AgentSkillsPage }));
const AgentExtensionPage = lazy(async () => ({ default: (await import("./pages/agent-extension-page.js")).AgentExtensionPage }));

const agentMcpPages = () => import("./pages/agent-mcp-pages.js");
const AgentMcpEditorPage = lazy(async () => ({ default: (await agentMcpPages()).AgentMcpEditorPage }));
const AgentMcpPage = lazy(async () => ({ default: (await agentMcpPages()).AgentMcpPage }));
const AgentParameterPage = lazy(async () => ({ default: (await import("./pages/agent-parameter-page.js")).AgentParameterPage }));

const projectEnvironmentPages = () => import("./pages/project-environment-pages.js");
const ProjectEnvironmentCreatePage = lazy(async () => ({ default: (await projectEnvironmentPages()).ProjectEnvironmentCreatePage }));
const ProjectEnvironmentDetailLayout = lazy(async () => ({ default: (await projectEnvironmentPages()).ProjectEnvironmentDetailLayout }));
const ProjectEnvironmentListPage = lazy(async () => ({ default: (await projectEnvironmentPages()).ProjectEnvironmentListPage }));
const ProjectEnvironmentOverviewPage = lazy(async () => ({ default: (await projectEnvironmentPages()).ProjectEnvironmentOverviewPage }));
const ProjectEnvironmentRepositoriesPage = lazy(async () => ({ default: (await projectEnvironmentPages()).ProjectEnvironmentRepositoriesPage }));

const SessionPage = lazy(async () => ({ default: (await import("./pages/session-page.js")).SessionPage }));
const sessionPages = () => import("./pages/session-pages.js");
const SessionCreatePage = lazy(async () => ({ default: (await sessionPages()).SessionCreatePage }));
const SessionListPage = lazy(async () => ({ default: (await sessionPages()).SessionListPage }));
const SessionSettingsPage = lazy(async () => ({ default: (await import("./pages/session-settings-page.js")).SessionSettingsPage }));
const ConcurrencySettingsPage = lazy(async () => ({ default: (await import("./pages/system-settings-page.js")).ConcurrencySettingsPage }));
const AgentUsagePage = lazy(async () => ({ default: (await import("./pages/agent-usage-page.js")).AgentUsagePage }));

const integrationPages = () => import("./pages/integration-pages.js");
const IntegrationConversationPage = lazy(async () => ({ default: (await integrationPages()).IntegrationConversationPage }));
const IntegrationEndpointCreatePage = lazy(async () => ({ default: (await integrationPages()).IntegrationEndpointCreatePage }));
const IntegrationEndpointDetailLayout = lazy(async () => ({ default: (await integrationPages()).IntegrationEndpointDetailLayout }));
const IntegrationEndpointListPage = lazy(async () => ({ default: (await integrationPages()).IntegrationEndpointListPage }));
const IntegrationEndpointMappingsPage = lazy(async () => ({ default: (await integrationPages()).IntegrationEndpointMappingsPage }));
const IntegrationEndpointOverviewPage = lazy(async () => ({ default: (await integrationPages()).IntegrationEndpointOverviewPage }));
const IntegrationEndpointUsagePage = lazy(async () => ({ default: (await integrationPages()).IntegrationEndpointUsagePage }));
const IntegrationEndpointReceiverPage = lazy(async () => ({ default: (await integrationPages()).IntegrationEndpointReceiverPage }));
const IntegrationEndpointSettingsPage = lazy(async () => ({ default: (await integrationPages()).IntegrationEndpointSettingsPage }));
const IntegrationEndpointTasksPage = lazy(async () => ({ default: (await integrationPages()).IntegrationEndpointTasksPage }));
const IntegrationEndpointWebhooksPage = lazy(async () => ({ default: (await integrationPages()).IntegrationEndpointWebhooksPage }));
const IntegrationTaskDetailPage = lazy(async () => ({ default: (await integrationPages()).IntegrationTaskDetailPage }));

type AppErrorBoundaryProps = { children: ReactNode };
type AppErrorBoundaryState = { failed: boolean };

class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Remote Agent web application failed", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <main className="grid min-h-svh place-items-center p-6">
      <section className="w-full max-w-lg rounded-xl border bg-card p-8 text-card-foreground shadow-lg" role="alert">
        <p className="font-mono text-xs font-bold tracking-[0.16em] text-muted-foreground">REMOTE AGENT SERVER</p>
        <h1 className="mt-4 text-2xl font-semibold">页面加载失败</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">前端资源可能刚刚更新，请重新加载页面。<br />The web application failed to load. Please reload the page.</p>
        <Button className="mt-6" type="button" onClick={() => window.location.reload()}>重新加载</Button>
      </section>
    </main>;
  }
}

export const App = () => <AppErrorBoundary><I18nProvider><Application /></I18nProvider></AppErrorBoundary>;

const Application = () => {
  const [token, setToken] = useState(() => sessionStorage.getItem("apiToken"));

  useEffect(() => {
    const disconnect = () => setToken(null);
    window.addEventListener(API_TOKEN_INVALID_EVENT, disconnect);
    return () => window.removeEventListener(API_TOKEN_INVALID_EVENT, disconnect);
  }, []);

  if (token === null) {
    return <TokenGate onSave={(value) => {
      sessionStorage.setItem("apiToken", value);
      setToken(value);
    }} />;
  }

  return <BrowserRouter><Suspense fallback={<main className="grid min-h-64 place-items-center text-sm text-muted-foreground" role="status">加载页面…</main>}><Routes>
    <Route element={<AppShellLayout onDisconnect={() => {
      sessionStorage.removeItem("apiToken");
      setToken(null);
    }} />}>
      <Route path="/agents" element={<AgentListPage />} />
      <Route path="/agents/new" element={<AgentCreatePage />} />
      <Route path="/agents/:id" element={<AgentDetailLayout />}>
        <Route index element={<AgentOverviewPage />} />
        <Route path="skills" element={<AgentSkillsPage />} />
        <Route path="extensions" element={<AgentExtensionPage />} />
        <Route path="parameters" element={<AgentParameterPage />} />
        <Route path="mcp" element={<AgentMcpPage />} />
        <Route path="settings" element={<AgentSettingsPage />} />
      </Route>
      <Route path="/agents/:id/mcp/new" element={<AgentMcpEditorPage />} />
      <Route path="/agents/:id/mcp/:mcpServerId" element={<AgentMcpEditorPage />} />
      <Route path="/project-environments" element={<ProjectEnvironmentListPage />} />
      <Route path="/project-environments/new" element={<ProjectEnvironmentCreatePage />} />
      <Route path="/project-environments/:id" element={<ProjectEnvironmentDetailLayout />}>
        <Route index element={<ProjectEnvironmentOverviewPage />} />
        <Route path="repositories" element={<ProjectEnvironmentRepositoriesPage />} />
      </Route>
      <Route path="/sessions" element={<SessionListPage />} />
      <Route path="/sessions/new" element={<SessionCreatePage />} />
      <Route path="/sessions/:id" element={<SessionRoute />} />
      <Route path="/sessions/:id/settings" element={<SessionSettingsPage />} />
      <Route path="/usage" element={<AgentUsagePage />} />
      <Route path="/system-settings" element={<Navigate to="/system-settings/concurrency" replace />} />
      <Route path="/system-settings/concurrency" element={<ConcurrencySettingsPage />} />
      <Route path="/integration-endpoints" element={<IntegrationEndpointListPage />} />
      <Route path="/integration-endpoints/new" element={<IntegrationEndpointCreatePage />} />
      <Route path="/integration-endpoints/:id" element={<IntegrationEndpointDetailLayout />}>
        <Route index element={<IntegrationEndpointOverviewPage />} />
        <Route path="usage" element={<IntegrationEndpointUsagePage />} />
        <Route path="receiver" element={<IntegrationEndpointReceiverPage />} />
        <Route path="mappings" element={<IntegrationEndpointMappingsPage />} />
        <Route path="webhooks" element={<IntegrationEndpointWebhooksPage />} />
        <Route path="conversations" element={<IntegrationConversationPage />} />
        <Route path="tasks" element={<IntegrationEndpointTasksPage />} />
        <Route path="settings" element={<IntegrationEndpointSettingsPage />} />
      </Route>
      <Route path="/integration-tasks/:id" element={<IntegrationTaskDetailPage />} />
      <Route path="*" element={<Navigate to="/agents" replace />} />
    </Route>
  </Routes></Suspense></BrowserRouter>;
};

const SessionRoute = () => {
  const { id = "" } = useParams();
  return <SessionPage sessionId={id} />;
};

const TokenGate = ({ onSave }: { onSave(token: string): void }) => {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { locale, setLocale, text } = useI18n();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const token = value.trim();
    if (token === "") return;
    setBusy(true);
    setError(null);
    try {
      if (await verifyApiToken(token)) {
        onSave(token);
      } else {
        setError(text("API 令牌无效", "Invalid API token"));
      }
    } catch {
      setError(text("无法连接服务器", "Unable to connect to the server"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-svh place-items-center bg-sidebar p-4 sm:p-6">
      <Card className="grid w-full max-w-4xl gap-0 overflow-hidden border-sidebar-border bg-card py-0 shadow-2xl md:grid-cols-[minmax(0,0.9fr)_minmax(24rem,1.1fr)]">
        <div className="hidden min-h-[30rem] flex-col justify-between bg-sidebar-accent p-10 text-sidebar-foreground md:flex">
          <div><span className="grid size-11 place-items-center rounded-xl bg-sidebar-primary font-mono text-sm font-black text-sidebar-primary-foreground">RA</span><p className="mt-6 font-mono text-xs font-bold tracking-[0.16em]">REMOTE AGENT SERVER</p></div>
          <div><p className="text-2xl font-semibold tracking-tight">{text("一个入口，管理所有远程智能体。", "One console for every remote agent.")}</p><p className="mt-3 text-sm leading-6 text-sidebar-foreground/70">{text("连接后管理智能体、项目环境、会话和外部接入。", "Connect to manage agents, project environments, sessions, and integrations.")}</p></div>
        </div>
        <div className="flex min-h-[30rem] flex-col justify-center p-6 sm:p-10">
          <CardHeader className="p-0">
            <div className="flex items-center justify-between gap-4"><p className="font-mono text-xs font-bold tracking-[0.16em] text-muted-foreground md:hidden">REMOTE AGENT SERVER</p><Button type="button" size="sm" variant="ghost" className="ml-auto" aria-label={text("切换为 English", "Switch to 简体中文")} onClick={() => setLocale(locale === "zh-CN" ? "en" : "zh-CN")}>{locale === "zh-CN" ? "English" : "简体中文"}</Button></div>
            <CardTitle id="token-title" role="heading" aria-level={1} className="mt-5 text-2xl sm:text-3xl">{text("连接智能体服务", "Connect to Remote Agent")}</CardTitle>
            <CardDescription className="mt-2 leading-6">{text("运行 pnpm run init 后，服务器 .env 中的 API_TOKEN 就是这里需要的令牌。凭证仅保留在当前浏览器会话中。", "After running pnpm run init, use the API_TOKEN from the server .env file here. It is kept only for this browser session.")}</CardDescription>
          </CardHeader>
          <CardContent className="p-0 pt-7"><form className="flex flex-col gap-4" onSubmit={submit} aria-labelledby="token-title"><FieldGroup>
            <Field><FieldLabel htmlFor="api-token">{text("API 令牌", "API token")}</FieldLabel><Input id="api-token" name="api-token" type="password" autoComplete="off" value={value} aria-invalid={error === null ? undefined : true} aria-describedby={error === null ? undefined : "api-token-error"} onChange={(event) => setValue(event.target.value)} /></Field>
            {error && <p id="api-token-error" className="text-sm text-destructive" role="alert">{error}</p>}
            <Button className="w-full" type="submit" disabled={busy || value.trim() === ""}>{busy ? text("正在验证…", "Verifying…") : text("进入管理台", "Open console")}</Button>
          </FieldGroup></form></CardContent>
        </div>
      </Card>
    </main>
  );
};
