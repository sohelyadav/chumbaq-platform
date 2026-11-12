import { Outlet, useLocation } from 'react-router-dom';
import { ProjectContextProvider } from '@/contexts/project-context';
import { AppSidebar } from '@/components/app-sidebar';
import { Badge } from '@/components/ui/badge';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Separator } from '@/components/ui/separator';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/toast';
import { useBreadcrumb } from '@/hooks/use-breadcrumb';
import { EmailVerificationBanner } from '@/components/email-verification-banner';
import { FactorResetPendingBanner } from '@/components/factor-reset-banner';
import { StaffLinkBanner } from '@/components/staff-link-banner';

const sectionTitles: Record<string, string> = {
  // The route is `segments` because that is the API's word for it; everywhere a
  // marketer reads it, it is an audience. Without this the breadcrumb said
  // "Segments" under a sidebar entry saying "Audiences".
  segments: 'Audiences',
  links: 'Links',
  widgets: 'Widgets',
  'api-keys': 'API Keys',
  webhooks: 'Webhooks',
  users: 'Users & Permissions',
  settings: 'Settings',
};

function getBreadcrumb(pathname: string) {
  // Pattern: /projects/:projectId/section/...
  const match = pathname.match(/^\/projects\/[^/]+\/(.*)$/);
  if (!match || !match[1]) {
    return { section: 'Dashboard', page: undefined };
  }

  const rest = match[1];
  const parts = rest.split('/');
  const sectionKey = parts[0];
  const section = sectionTitles[sectionKey] || sectionKey.charAt(0).toUpperCase() + sectionKey.slice(1);

  if (parts.length === 1) {
    return { section, page: undefined };
  }

  const sub = parts[parts.length - 1];
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(sub);
  if (isUuid) {
    return { section, page: undefined };
  }

  const subTitle = sub === 'new' ? 'Create' : sub === 'edit' ? 'Edit' : sub;
  return { section, page: subTitle.charAt(0).toUpperCase() + subTitle.slice(1) };
}

export function AppLayout() {
  const location = useLocation();
  const { section, page } = getBreadcrumb(location.pathname);
  const { override } = useBreadcrumb();

  return (
    <ProjectContextProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="h-svh overflow-hidden">
          <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4 bg-white dark:bg-card transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
            <SidebarTrigger className="-ml-1" />
            <Separator
              orientation="vertical"
              className="mr-2 data-[orientation=vertical]:h-4"
            />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem className="hidden md:block">
                  <BreadcrumbLink href="#">{section}</BreadcrumbLink>
                </BreadcrumbItem>
                {override ? (
                  <>
                    <BreadcrumbSeparator className="hidden md:block" />
                    <BreadcrumbItem>
                      <BreadcrumbPage className="flex items-center gap-1.5">
                        {override.label}
                        {override.badge && (
                          <Badge variant={override.badge.variant} className="text-[10px] px-1.5 py-0">
                            {override.badge.text}
                          </Badge>
                        )}
                      </BreadcrumbPage>
                    </BreadcrumbItem>
                  </>
                ) : page ? (
                  <>
                    <BreadcrumbSeparator className="hidden md:block" />
                    <BreadcrumbItem>
                      <BreadcrumbPage>{page}</BreadcrumbPage>
                    </BreadcrumbItem>
                  </>
                ) : null}
              </BreadcrumbList>
            </Breadcrumb>
          </header>
          <EmailVerificationBanner />
          <FactorResetPendingBanner />
          <StaffLinkBanner />
          <main className="flex-1 overflow-y-auto p-4 lg:p-6">
            <Outlet />
          </main>
        </SidebarInset>
        <Toaster />
      </SidebarProvider>
    </ProjectContextProvider>
  );
}
