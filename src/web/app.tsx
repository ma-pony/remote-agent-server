import { Component, lazy, type ErrorInfo, type FormEvent, type ReactNode, useEffect, useState } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes, useParams } from "react-router";
import { FileQuestion } from "lucide-react";

import { AppShellLayout } from "./components/app-shell.js";
import { Button } from "./components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card.js";
import { Input } from "./components/ui/input.js";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./components/ui/field.js";
import { EmptyState, PageContainer } from "./components/page-header.js";
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
const UsageDashboardPage = lazy(async () => ({ default: (await import("./pages/usage-dashboard-page.js")).UsageDashboardPage }));

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
    return <ApplicationError />;
  }
}

const ApplicationError = () => {
  const { text } = useI18n();
  return <main className="grid min-h-svh place-items-center p-6">
    <Card className="w-full max-w-lg" role="alert">
      <CardHeader><h1 className="text-2xl font-semibold">{text("页面加载失败", "Page could not load")}</h1>
        <CardDescription>{text("请重新加载页面。如果仍然失败，请检查网络连接或联系服务管理员。", "Reload the page. If it still fails, check your connection or contact the server administrator.")}</CardDescription>
      </CardHeader>
      <CardContent><Button onClick={() => window.location.reload()}>{text("重新加载", "Reload page")}</Button></CardContent>
    </Card>
  </main>;
};

const NotFoundPage = () => {
  const { text } = useI18n();
  return <PageContainer><EmptyState headingLevel={1} icon={FileQuestion} title={text("找不到这个页面", "Page not found")}
    description={text("请检查网址，或从侧栏选择要打开的页面。", "Check the URL or choose a page from the sidebar.")}
    action={<Button asChild><Link to="/agents">{text("返回智能体", "Back to agents")}</Link></Button>} /></PageContainer>;
};

export const App = () => <I18nProvider><AppErrorBoundary><Application /></AppErrorBoundary></I18nProvider>;

const Application = () => {
  const [token, setToken] = useState(() => sessionStorage.getItem("apiToken"));
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const disconnect = () => { setExpired(true); setToken(null); };
    window.addEventListener(API_TOKEN_INVALID_EVENT, disconnect);
    return () => window.removeEventListener(API_TOKEN_INVALID_EVENT, disconnect);
  }, []);

  if (token === null) {
    return <TokenGate expired={expired} onSave={(value) => {
      sessionStorage.setItem("apiToken", value);
      setExpired(false);
      setToken(value);
    }} />;
  }

  return <BrowserRouter><Routes>
    <Route element={<AppShellLayout onDisconnect={() => {
      sessionStorage.removeItem("apiToken");
      setExpired(false);
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
      <Route path="/dashboard" element={<UsageDashboardPage />} />
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
      <Route path="/" element={<Navigate to="/agents" replace />} />
      <Route path="*" element={<NotFoundPage />} />
    </Route>
  </Routes></BrowserRouter>;
};

const SessionRoute = () => {
  const { id = "" } = useParams();
  return <SessionPage sessionId={id} />;
};

const TokenGate = ({ onSave, expired }: { onSave(token: string): void; expired: boolean }) => {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"invalid" | "network" | null>(null);
  const { locale, setLocale, text } = useI18n();
  useEffect(() => { document.title = text("连接服务 · Remote Agent Server", "Connect · Remote Agent Server"); }, [text]);

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
        setError("invalid");
      }
    } catch {
      setError("network");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-svh place-items-center bg-sidebar p-4 sm:p-6">
      <Card className="grid w-full max-w-4xl gap-0 overflow-hidden border-sidebar-border bg-card py-0 shadow-2xl md:grid-cols-[minmax(0,0.9fr)_minmax(24rem,1.1fr)]">
        <div className="hidden min-h-[30rem] flex-col justify-between bg-sidebar-accent p-10 text-sidebar-foreground md:flex">
          <div><span className="grid size-11 place-items-center rounded-xl bg-sidebar-primary font-mono text-sm font-black text-sidebar-primary-foreground">RA</span><p className="mt-6 font-mono text-xs font-bold tracking-[0.16em]">REMOTE AGENT SERVER</p></div>
          <div><p className="text-2xl font-semibold tracking-tight">{text("配置智能体，跟踪每次执行。", "Configure agents. Track every run.")}</p><p className="mt-3 text-sm leading-6 text-sidebar-foreground/70">{text("管理项目环境和会话，查看 token 用量，为外部系统配置接入端点。", "Manage environments and sessions, inspect token usage, and connect external systems.")}</p></div>
        </div>
        <div className="flex min-h-[30rem] flex-col justify-center p-6 sm:p-10">
          <CardHeader className="p-0">
            <div className="flex items-center justify-between gap-4"><p className="font-mono text-xs font-bold tracking-[0.16em] text-muted-foreground md:hidden">REMOTE AGENT SERVER</p><Button type="button" size="sm" variant="ghost" className="ml-auto" aria-label={text("切换为 English", "Switch to 简体中文")} onClick={() => setLocale(locale === "zh-CN" ? "en" : "zh-CN")}>{locale === "zh-CN" ? "English" : "简体中文"}</Button></div>
            <CardTitle id="token-title" role="heading" aria-level={1} className="mt-5 text-2xl sm:text-3xl">{text("连接智能体服务", "Connect to Remote Agent")}</CardTitle>
            <CardDescription className="mt-2 leading-6">{text("使用服务管理员提供的 API 令牌进入管理台。", "Enter the API token provided by your server administrator.")}</CardDescription>
          </CardHeader>
          <CardContent className="p-0 pt-7"><form className="flex flex-col gap-4" onSubmit={submit} aria-labelledby="token-title"><FieldGroup>
            {expired ? <p className="text-sm text-muted-foreground" role="status">{text("当前令牌已失效，请重新输入有效令牌。", "Your token is no longer valid. Enter a valid token to reconnect.")}</p> : null}
            <Field><FieldLabel htmlFor="api-token">{text("API 令牌", "API token")}</FieldLabel><Input id="api-token" name="api-token" type="password" autoComplete="off" disabled={busy} value={value} aria-invalid={error === "invalid" || undefined} aria-describedby={`api-token-help${error ? " api-token-error" : ""}`} onChange={(event) => { setValue(event.target.value); setError(null); }} />
              <FieldDescription id="api-token-help">{text("令牌仅保留在当前浏览器会话中。", "The token is kept only for this browser session.")}</FieldDescription>
            </Field>
            {error && <p id="api-token-error" className="text-sm text-destructive" role="alert">{error === "invalid" ? text("API 令牌无效。请检查是否复制完整，或向管理员获取有效令牌。", "Invalid API token. Check that you copied it in full, or request a valid token from your administrator.") : text("无法连接服务器。请检查网络和服务地址，然后重试。", "Unable to connect to the server. Check your network and server address, then try again.")}</p>}
            <Button className="w-full" type="submit" disabled={busy || value.trim() === ""}>{busy ? text("正在验证…", "Verifying…") : text("进入管理台", "Open console")}</Button>
          </FieldGroup></form>
            <details className="mt-6 text-sm text-muted-foreground"><summary className="cursor-pointer rounded-sm text-foreground">{text("在哪里找到令牌？", "Where do I find the token?")}</summary>
              <p className="mt-2 leading-6">{text("自行部署时，运行 pnpm run init 后，在服务器的 .env 文件中查看 API_TOKEN。", "For a self-hosted server, run pnpm run init and find API_TOKEN in the server's .env file.")}</p>
            </details>
          </CardContent>
        </div>
      </Card>
    </main>
  );
};
