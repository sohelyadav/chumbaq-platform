import { RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/hooks/use-auth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { ThemeProvider } from '@/hooks/use-theme';
import { BreadcrumbProvider } from '@/hooks/use-breadcrumb';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ImpersonationBanner } from '@/components/impersonation-banner';
import { router } from '@/router';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export default function App() {
  return (
    <ThemeProvider>
      <ImpersonationBanner />
      <BreadcrumbProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <TooltipProvider>
              <ReauthDialog />
              <RouterProvider router={router} />
            </TooltipProvider>
          </AuthProvider>
        </QueryClientProvider>
      </BreadcrumbProvider>
    </ThemeProvider>
  );
}
