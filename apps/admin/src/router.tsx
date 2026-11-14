import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { AdminLayout } from '@/components/admin-layout';
import { useStaffAuth } from '@/hooks/use-staff-auth';
import SignInPage from '@/pages/sign-in';
import EnrolPage from '@/pages/enrol';
import AccountPage from '@/pages/account';
import OverviewPage from '@/pages/overview';
import TenantsListPage from '@/pages/tenants-list';
import TenantDetailPage from '@/pages/tenant-detail';
import AuditLogPage from '@/pages/audit-log';
import HealthPage from '@/pages/health';
import IncidentsListPage from '@/pages/incidents-list';
import IncidentDetailPage from '@/pages/incident-detail';
import BillingPage from '@/pages/billing';
import PlansPage from '@/pages/plans';

function Waiting() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
    </div>
  );
}

function Unreachable() {
  const { retry } = useStaffAuth();
  return (
    <div role="alert" className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm">Could not reach the admin API.</p>
      <Button variant="outline" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}

/**
 * Navigation only: the admin API checks every request. Which pages a session may open
 * follows what the API allows it: an enrolment-only session gets /enrol and nothing else.
 */
function Gate({ need }: { need: 'none' | 'enrolment' | 'full' }) {
  const { status, profile } = useStaffAuth();
  if (status === 'loading') return <Waiting />;
  if (status === 'unreachable') return <Unreachable />;
  const signedIn = status === 'signed_in' && profile;
  const home = !signedIn ? '/sign-in' : profile.enrolmentOnly ? '/enrol' : '/';

  if (need === 'none') return signedIn ? <Navigate to={home} replace /> : <Outlet />;
  if (!signedIn) return <Navigate to="/sign-in" replace />;
  if (need === 'enrolment' && !profile.enrolmentOnly) return <Navigate to="/account" replace />;
  if (need === 'full' && profile.enrolmentOnly) return <Navigate to="/enrol" replace />;
  return <Outlet />;
}

export const router = createBrowserRouter([
  { element: <Gate need="none" />, children: [{ path: '/sign-in', element: <SignInPage /> }] },
  { element: <Gate need="enrolment" />, children: [{ path: '/enrol', element: <EnrolPage /> }] },
  {
    element: <Gate need="full" />,
    children: [
      {
        path: '/',
        element: <AdminLayout />,
        children: [
          { index: true, element: <OverviewPage /> },
          { path: 'tenants', element: <TenantsListPage /> },
          { path: 'tenants/:tenantId', element: <TenantDetailPage /> },
          { path: 'billing', element: <BillingPage /> },
          { path: 'plans', element: <PlansPage /> },
          { path: 'audit-log', element: <AuditLogPage /> },
          { path: 'health', element: <HealthPage /> },
          { path: 'incidents', element: <IncidentsListPage /> },
          { path: 'incidents/:incidentId', element: <IncidentDetailPage /> },
          { path: 'account', element: <AccountPage /> },
          { path: '*', element: <Navigate to="/" replace /> },
        ],
      },
    ],
  },
]);
