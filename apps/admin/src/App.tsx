import { RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StaffAuthProvider } from '@/hooks/use-staff-auth';
import { BreadcrumbProvider } from '@/hooks/use-breadcrumb';
import { ReauthDialog } from '@/components/reauth-dialog';
import { TooltipProvider } from '@/components/ui/tooltip';
import { setNavigator } from '@/lib/api';
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

// In-app, so an enrolment-only session's token (memory only, no cookie) survives it.
setNavigator((path) => void router.navigate(path));

export default function App() {
  return (
    <BreadcrumbProvider>
      <QueryClientProvider client={queryClient}>
        <StaffAuthProvider>
          <TooltipProvider>
            <ReauthDialog />
            <RouterProvider router={router} />
          </TooltipProvider>
        </StaffAuthProvider>
      </QueryClientProvider>
    </BreadcrumbProvider>
  );
}
