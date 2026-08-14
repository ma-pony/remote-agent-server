import { Bot, Boxes, Cable, LogOut, MessagesSquare } from "lucide-react";
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

const navigation = [
  { label: "Agent", path: "/agents", icon: Bot },
  { label: "项目环境", path: "/project-environments", icon: Boxes },
  { label: "Session", path: "/sessions", icon: MessagesSquare },
  { label: "接入端点", path: "/integration-endpoints", icon: Cable }
] as const;

export const AppShellLayout = ({ onDisconnect }: { onDisconnect(): void }) => {
  return (
  <TooltipProvider>
    <SidebarProvider>
      <AppNavigationSidebar onDisconnect={onDisconnect} />
      <SidebarInset>
        <header className="sticky top-0 z-20 flex h-14 items-center border-b bg-background/95 px-4 backdrop-blur md:px-6">
          <SidebarTrigger aria-label="切换导航" />
        </header>
        <main className="min-w-0 flex-1"><Outlet /></main>
      </SidebarInset>
    </SidebarProvider>
  </TooltipProvider>
  );
};

const AppNavigationSidebar = ({ onDisconnect }: { onDisconnect(): void }) => {
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
              <nav aria-label="主导航">
              <SidebarMenu>
                {navigation.map(({ label, path, icon: Icon }) => <SidebarMenuItem key={path}>
                  <SidebarMenuButton asChild isActive={pathname === path || pathname.startsWith(`${path}/`)} tooltip={label}>
                    <NavLink to={path} onClick={closeMobile}>
                      <Icon aria-hidden="true" /><span>{label}</span>
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
            <span className="size-2 rounded-full bg-sidebar-primary" />已连接
          </div>
          <Button variant="ghost" className="w-full justify-start" onClick={() => { closeMobile(); onDisconnect(); }}>
            <LogOut aria-hidden="true" /><span className="group-data-[collapsible=icon]:hidden">断开</span>
          </Button>
        </SidebarFooter>
      </Sidebar>
  ;
};
