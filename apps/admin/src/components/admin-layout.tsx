import { Link, Outlet, useLocation } from 'react-router-dom';
import {
  Activity,
  LogOut,
  UserCog,
  Building2,
  CreditCard,
  Layers,
  LayoutDashboard,
  ScrollText,
  ShieldCheck,
  ShieldAlert,
} from 'lucide-react';
import { NavMain } from '@/components/nav-main';
import { Badge } from '@/components/ui/badge';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Separator } from '@/components/ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/toast';
import { useBreadcrumb } from '@/hooks/use-breadcrumb';
import { useStaffAuth } from '@/hooks/use-staff-auth';

const navItems = [
  { title: 'Overview', url: '/', icon: LayoutDashboard, exact: true },
  { title: 'Tenants', url: '/tenants', icon: Building2 },
  { title: 'Billing', url: '/billing', icon: CreditCard, billingOnly: true },
  { title: 'Plans', url: '/plans', icon: Layers },
  { title: 'Audit log', url: '/audit-log', icon: ScrollText },
  { title: 'Incidents', url: '/incidents', icon: ShieldAlert },
  { title: 'Platform health', url: '/health', icon: Activity },
  { title: 'Your account', url: '/account', icon: UserCog },
];

function sectionTitle(pathname: string): string {
  const match = navItems.find(
    (item) => !item.exact && (pathname === item.url || pathname.startsWith(`${item.url}/`)),
  );
  return match?.title ?? 'Overview';
}

/** Who is signed in, and the way out. */
function StaffFooter() {
  const { profile, signOut } = useStaffAuth();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div className="truncate px-2 py-1 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
          {profile?.email}
        </div>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton tooltip="Sign out" onClick={() => void signOut()}>
          <LogOut />
          <span>Sign out</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function AdminSidebar() {
  // Billing only where this server takes payments; plans can be prepared either way.
  const billingEnabled = useStaffAuth().profile?.billingEnabled === true;
  const items = navItems.filter((item) => !item.billingOnly || billingEnabled);
  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="Super Admin">
              <Link to="/">
                {/* Inverted rather than `primary`: the accent is user-selectable,
                    so it could match the tenant dashboard exactly. */}
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-foreground text-background">
                  <ShieldCheck className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">Chumbaq</span>
                  <span className="truncate text-xs">Super Admin</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain label="Platform" items={items} />
      </SidebarContent>
      <SidebarFooter>
        <StaffFooter />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

export function AdminLayout() {
  const { pathname } = useLocation();
  const { override } = useBreadcrumb();

  return (
    <SidebarProvider>
      <AdminSidebar />
      {/* min-w-0 so a wide table scrolls inside its card, not the whole page. */}
      <SidebarInset className="h-svh min-w-0 overflow-hidden">
        <header className="flex h-16 shrink-0 items-center gap-2 border-b border-t-2 border-t-foreground px-4 bg-white dark:bg-card">
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mr-2 data-vertical:h-4 data-vertical:self-center"
          />
          <Badge className="bg-foreground text-background">
            <ShieldCheck />
            Super Admin
          </Badge>
          <Breadcrumb className="ml-2 min-w-0">
            <BreadcrumbList className="flex-nowrap">
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbPage className="text-muted-foreground">
                  {sectionTitle(pathname)}
                </BreadcrumbPage>
              </BreadcrumbItem>
              {override && (
                <>
                  <BreadcrumbSeparator className="hidden md:block" />
                  <BreadcrumbItem className="min-w-0">
                    <BreadcrumbPage className="truncate">{override.label}</BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              )}
            </BreadcrumbList>
          </Breadcrumb>
          <span className="ml-auto hidden shrink-0 text-xs text-muted-foreground lg:inline">
            Staff only. Actions here apply across all tenants.
          </span>
        </header>
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          <Outlet />
        </main>
      </SidebarInset>
      <Toaster />
    </SidebarProvider>
  );
}
