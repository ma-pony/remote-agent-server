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

const integrationPages = () => import("./pages/integration-pages.js");
const IntegrationConversationPage = lazy(async () => ({ default: (await integrationPages()).IntegrationConversationPage }));
const IntegrationEndpointCreatePage = lazy(async () => ({ default: (await integrationPages()).IntegrationEndpointCreatePage }));
const IntegrationEndpointDetailLayout = lazy(async () => ({ default: (await integrationPages()).IntegrationEndpointDetailLayout }));
const IntegrationEndpointListPage = lazy(async () => ({ default: (await integrationPages()).IntegrationEndpointListPage }));
const IntegrationEndpointMappingsPage = lazy(async () => ({ default: (await integrationPages()).IntegrationEndpointMappingsPage }));
const IntegrationEndpointOverviewPage = lazy(async () => ({ default: (await integrationPages()).IntegrationEndpointOverviewPage }));
const IntegrationEndpointUsagePage = lazy(async () => ({ default: (await integrationPages()).IntegrationEndpointUsagePage }));
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
        <button className="mt-6 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground" type="button" onClick={() => window.location.reload()}>重新加载</button>
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
      <Route path="/integration-endpoints" element={<IntegrationEndpointListPage />} />
      <Route path="/integration-endpoints/new" element={<IntegrationEndpointCreatePage />} />
      <Route path="/integration-endpoints/:id" element={<IntegrationEndpointDetailLayout />}>
        <Route index element={<IntegrationEndpointOverviewPage />} />
        <Route path="usage" element={<IntegrationEndpointUsagePage />} />
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
    <main className="grid min-h-svh place-items-center bg-sidebar p-5">
      <Card className="w-full max-w-md border-0 border-t-4 border-t-sidebar-primary shadow-2xl">
        <CardHeader className="flex flex-col gap-3 p-7 pb-3 sm:p-9 sm:pb-3">
          <div className="flex items-center justify-between gap-4"><p className="font-mono text-xs font-bold tracking-[0.16em] text-muted-foreground">REMOTE AGENT SERVER</p><Button type="button" size="sm" variant="ghost" aria-label={text("切换为 English", "Switch to 简体中文")} onClick={() => setLocale(locale === "zh-CN" ? "en" : "zh-CN")}>{locale === "zh-CN" ? "English" : "简体中文"}</Button></div>
          <CardTitle id="token-title" role="heading" aria-level={1} className="text-3xl">{text("连接智能体服务", "Connect to Remote Agent")}</CardTitle>
          <CardDescription className="leading-6">{text("输入服务器 API 令牌。凭证仅保留在当前浏览器会话中。", "Enter the server API token. It is kept only for this browser session.")}</CardDescription>
        </CardHeader>
        <CardContent className="p-7 pt-4 sm:p-9 sm:pt-4"><form className="flex flex-col gap-4" onSubmit={submit} aria-labelledby="token-title"><FieldGroup>
          <Field><FieldLabel htmlFor="api-token">{text("API 令牌", "API token")}</FieldLabel><Input id="api-token" type="password" autoComplete="off" value={value} aria-invalid={error === null ? undefined : true} onChange={(event) => setValue(event.target.value)} autoFocus /></Field>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <Button className="w-full" type="submit" disabled={busy}>{busy ? text("正在验证…", "Verifying…") : text("进入管理台", "Open console")}</Button>
        </FieldGroup></form></CardContent>
      </Card>
    </main>
  );
};
