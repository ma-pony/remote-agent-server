import { Bot, Boxes, Cable, Languages, LogOut, MessagesSquare } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router";

import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n";

const navigation = [
  { label: ["智能体", "Agents"], path: "/agents", icon: Bot },
  { label: ["项目环境", "Project environments"], path: "/project-environments", icon: Boxes },
  { label: ["会话", "Sessions"], path: "/sessions", icon: MessagesSquare },
  { label: ["接入端点", "Integration endpoints"], path: "/integration-endpoints", icon: Cable }
] as const;

export const AppShellLayout = ({ onDisconnect }: { onDisconnect(): void }) => {
  const { text } = useI18n();
  return (
  <TooltipProvider>
    <SidebarProvider>
      <AppNavigationSidebar onDisconnect={onDisconnect} />
      <SidebarInset>
        <header className="sticky top-0 z-20 flex h-14 items-center border-b bg-background/95 px-4 backdrop-blur md:px-6">
          <SidebarTrigger aria-label={text("切换导航", "Toggle navigation")} />
        </header>
        <main className="min-w-0 flex-1"><Outlet /></main>
      </SidebarInset>
    </SidebarProvider>
  </TooltipProvider>
  );
};

const AppNavigationSidebar = ({ onDisconnect }: { onDisconnect(): void }) => {
  const { locale, setLocale, text } = useI18n();
  const { pathname } = useLocation();
  const { setOpenMobile } = useSidebar();
  const closeMobile = () => setOpenMobile(false);

  return <Sidebar collapsible="icon">
        <SidebarHeader className="border-b border-sidebar-border p-4">
          <NavLink className="flex items-center gap-3 overflow-hidden" to="/agents" onClick={closeMobile}>
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-sidebar-primary font-mono text-xs font-black text-sidebar-primary-foreground">RA</span>
            <span className="truncate font-mono text-xs font-black tracking-[0.16em]">REMOTE AGENT</span>
          </NavLink>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <nav aria-label={text("主导航", "Main navigation")}>
              <SidebarMenu>
                {navigation.map(({ label: [chinese, english], path, icon: Icon }) => <SidebarMenuItem key={path}>
                  <SidebarMenuButton asChild isActive={pathname === path || pathname.startsWith(`${path}/`)} tooltip={text(chinese, english)}>
                    <NavLink to={path} onClick={closeMobile}>
                      <Icon aria-hidden="true" /><span>{text(chinese, english)}</span>
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>)}
              </SidebarMenu>
              </nav>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="border-t border-sidebar-border p-3">
          <div className="mb-2 flex items-center gap-2 px-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            <span className="size-2 rounded-full bg-sidebar-primary" />{text("已连接", "Connected")}
          </div>
          <Button variant="ghost" className="w-full justify-start" aria-label={text("切换为 English", "Switch to 简体中文")} onClick={() => setLocale(locale === "zh-CN" ? "en" : "zh-CN")}>
            <Languages aria-hidden="true" /><span className="group-data-[collapsible=icon]:hidden">{locale === "zh-CN" ? "English" : "简体中文"}</span>
          </Button>
          <Button variant="ghost" className="w-full justify-start" onClick={() => { closeMobile(); onDisconnect(); }}>
            <LogOut aria-hidden="true" /><span className="group-data-[collapsible=icon]:hidden">{text("断开连接", "Disconnect")}</span>
          </Button>
        </SidebarFooter>
      </Sidebar>
  ;
};
