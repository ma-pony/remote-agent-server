import { FormEvent, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router";

import { AppShellLayout } from "./components/app-shell.js";
import { Button } from "./components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card.js";
import { Input } from "./components/ui/input.js";
import { Field, FieldGroup, FieldLabel } from "./components/ui/field.js";
import {
  AgentCreatePage, AgentDetailLayout, AgentListPage, AgentOverviewPage,
  AgentSettingsPage, AgentSkillsPage
} from "./pages/agent-pages.js";
import { AgentMcpEditorPage, AgentMcpPage } from "./pages/agent-mcp-pages.js";
import {
  ProjectEnvironmentCreatePage, ProjectEnvironmentDetailLayout, ProjectEnvironmentListPage,
  ProjectEnvironmentOverviewPage, ProjectEnvironmentRepositoriesPage
} from "./pages/project-environment-pages.js";
import { SessionPage } from "./pages/session-page.js";
import { SessionCreatePage, SessionListPage } from "./pages/session-pages.js";
import { SessionSettingsPage } from "./pages/session-settings-page.js";

export const App = () => {
  const [token, setToken] = useState(() => sessionStorage.getItem("apiToken"));

  if (token === null) {
    return <TokenGate onSave={(value) => {
      sessionStorage.setItem("apiToken", value);
      setToken(value);
    }} />;
  }

  return <BrowserRouter><Routes>
    <Route element={<AppShellLayout onDisconnect={() => {
      sessionStorage.removeItem("apiToken");
      setToken(null);
    }} />}>
      <Route path="/agents" element={<AgentListPage />} />
      <Route path="/agents/new" element={<AgentCreatePage />} />
      <Route path="/agents/:id" element={<AgentDetailLayout />}>
        <Route index element={<AgentOverviewPage />} />
        <Route path="skills" element={<AgentSkillsPage />} />
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
      <Route path="*" element={<Navigate to="/agents" replace />} />
    </Route>
  </Routes></BrowserRouter>;
};

const SessionRoute = () => {
  const { id = "" } = useParams();
  return <SessionPage sessionId={id} />;
};

const TokenGate = ({ onSave }: { onSave(token: string): void }) => {
  const [value, setValue] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const token = value.trim();
    if (token !== "") onSave(token);
  };

  return (
    <main className="grid min-h-svh place-items-center bg-sidebar p-5">
      <Card className="w-full max-w-md border-0 border-t-4 border-t-sidebar-primary shadow-2xl">
        <CardHeader className="flex flex-col gap-3 p-7 pb-3 sm:p-9 sm:pb-3">
          <p className="font-mono text-xs font-bold tracking-[0.16em] text-muted-foreground">REMOTE AGENT SERVER</p>
          <CardTitle id="token-title" className="text-3xl">连接 Remote Agent</CardTitle>
          <CardDescription className="leading-6">输入服务器 API Token。凭证仅保留在当前浏览器会话中。</CardDescription>
        </CardHeader>
        <CardContent className="p-7 pt-4 sm:p-9 sm:pt-4"><form className="flex flex-col gap-4" onSubmit={submit} aria-labelledby="token-title"><FieldGroup>
          <Field><FieldLabel htmlFor="api-token">API Token</FieldLabel><Input id="api-token" type="password" autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} autoFocus /></Field>
          <Button className="w-full" type="submit">进入管理台</Button>
        </FieldGroup></form></CardContent>
      </Card>
    </main>
  );
};
