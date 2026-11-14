import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '@/hooks/use-auth';
import { AppLayout } from '@/components/layout/app-layout';
import { MinimalLayout } from '@/components/layout/minimal-layout';
import LoginPage from '@/pages/login';
import RegisterPage from '@/pages/register';
import ForgotPasswordPage from '@/pages/forgot-password';
import ResetPasswordPage from '@/pages/reset-password';
import VerifyEmailPage from '@/pages/verify-email';
import { pendingVerification } from '@/lib/account-links';
import { pendingInvite } from '@/lib/pending-invite';
import InvitePage from '@/pages/invite';
import { CANCEL_SUPPORT_LINK_PATH, nextAfterSignIn } from '@/lib/staff-link';
import CancelSupportLinkPage from '@/pages/account/cancel-support-link';
import BillingPage from '@/pages/account/billing';
import { BILLING_PATH } from '@/lib/billing-route';
import DashboardPage from '@/pages/dashboard';
import LinksListPage from '@/pages/links/links-list';
import LinkCreatePage from '@/pages/links/link-create';
import LinkDetailPage from '@/pages/links/link-detail';
import LinkEditPage from '@/pages/links/link-edit';
import LinkBulkImportPage from '@/pages/links/link-bulk-import';
import ProjectSelectorPage from '@/pages/projects/project-selector';
import ProjectSettingsPage from '@/pages/projects/project-settings';
import ProjectApiKeysPage from '@/pages/projects/project-api-keys';
import ProjectWebhooksPage from '@/pages/projects/project-webhooks';

import BannersListPage from '@/pages/in-app-banners/banners-list';
import BannerDetailPage from '@/pages/in-app-banners/banner-detail';
import BannerEditorPage from '@/pages/in-app-banners/banner-editor';
import ItemReportPage from '@/pages/in-app-banners/item-report';
import ProjectMembersPage from '@/pages/projects/project-members';
import ProjectActivityPage from '@/pages/projects/project-activity';
import ProjectPushNotificationsPage from '@/pages/projects/project-push-notifications';
import SegmentsListPage from '@/pages/projects/segments-list';
import SegmentEditorPage from '@/pages/projects/segment-editor';
import JourneysListPage from '@/pages/projects/journeys-list';
import JourneyEditorPage from '@/pages/projects/journey-editor';
import PushCampaignComposerPage from '@/pages/projects/push-campaign-composer';
import PushCampaignDetailPage from '@/pages/projects/push-campaign-detail';
import ProjectEmailPage from '@/pages/projects/project-email';
import EmailCampaignComposerPage from '@/pages/projects/email-campaign-composer';
import ProjectSmsPage from '@/pages/projects/project-sms';
import SmsCampaignComposerPage from '@/pages/projects/sms-campaign-composer';
import ProjectWhatsAppPage from '@/pages/projects/project-whatsapp';
import WhatsAppCampaignComposerPage from '@/pages/projects/whatsapp-campaign-composer';
import ProjectAnalyticsPage from '@/pages/projects/project-analytics';
import UsersListPage from '@/pages/users/users-list';
import UserMemberDetailPage from '@/pages/users/user-member-detail';
import EventExplorerPage from '@/pages/events/event-explorer';
import AttributionDashboardPage from '@/pages/attribution/attribution-dashboard';
import TouchpointsPage from '@/pages/touchpoints/touchpoints-page';
import MixpanelConfigurePage from '@/pages/mixpanel/mixpanel-configure';
import MixpanelCohortsListPage from '@/pages/mixpanel/mixpanel-cohorts-list';
import MixpanelCohortDetailPage from '@/pages/mixpanel/mixpanel-cohort-detail';
import InAppMessagesCampaignListPage from '@/pages/in-app-messages/campaign-list';
import CampaignEditorPage from '@/pages/in-app-messages/campaign-editor';
import CampaignDetailPage from '@/pages/in-app-messages/campaign-detail';
import ShortRedirectPage from '@/pages/short-redirect';
import UserSettingsPage from '@/pages/settings/user-settings';
import ImpersonatePage from '@/pages/impersonate';
import { HANDOFF_PATH } from '@/lib/impersonation-handoff';

function ProtectedRoute() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}

function PublicRoute() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (isAuthenticated) {
    // Back to the link that sent them through sign-in, which needs this session. The
    // cancel page asks for `next` itself, so a session that already exists goes
    // straight there rather than on to the projects.
    // An invite opened while signed out goes first: it is why they signed in or signed up.
    const next =
      nextAfterSignIn(window.location.search) ??
      (pendingInvite.read(window.sessionStorage)
        ? '/invite'
        : pendingVerification.read(window.sessionStorage)
          ? '/verify-email'
          : '/projects');
    return <Navigate to={next} replace />;
  }

  return <Outlet />;
}

export const router = createBrowserRouter([
  {
    element: <PublicRoute />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/register', element: <RegisterPage /> },
      { path: '/forgot-password', element: <ForgotPasswordPage /> },
    ],
  },
  // Public, but not under PublicRoute: that sends anyone signed in to /projects before
  // the page could read its token, and the person confirming an address usually is.
  { path: '/verify-email', element: <VerifyEmailPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  // The button in the "Support issued a password reset link" email. Not under either
  // guard: it works from an existing session, and signs in first (coming back here)
  // when there is none.
  { path: CANCEL_SUPPORT_LINK_PATH, element: <CancelSupportLinkPage /> },
  // The admin app's "View as" lands here in a new tab. Under neither guard: it works
  // whether or not this browser is signed in to the customer app, and never touches
  // that session. `impersonate` is a reserved short code in the links module.
  { path: HANDOFF_PATH, element: <ImpersonatePage /> },
  // An invite link, `/invite#token=...`. Under neither guard, like the two above: signed
  // out it keeps the token through sign-in or sign-up, signed in it shows the invite.
  // `invite` is a reserved short code in the links module.
  { path: '/invite', element: <InvitePage /> },
  {
    element: <ProtectedRoute />,
    children: [
      // Project selector and global user settings (no sidebar)
      {
        element: <MinimalLayout />,
        children: [
          { path: '/projects', element: <ProjectSelectorPage /> },
          { path: '/settings', element: <UserSettingsPage /> },
          // The account's billing (it owns billing, not a project). Shows "Not found"
          // while the API says billing is off. `account` is a reserved short code.
          { path: BILLING_PATH, element: <BillingPage /> },
        ],
      },
      // Redirect root to projects
      { path: '/', element: <Navigate to="/projects" replace /> },
      // Project-scoped routes (with sidebar)
      {
        path: '/projects/:projectId',
        element: <AppLayout />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'analytics', element: <ProjectAnalyticsPage /> },
          { path: 'attribution', element: <AttributionDashboardPage /> },
          { path: 'touchpoints', element: <TouchpointsPage /> },
          { path: 'users', element: <UsersListPage /> },
          { path: 'users/:personId', element: <UserMemberDetailPage /> },
          { path: 'events', element: <EventExplorerPage /> },
          { path: 'links', element: <LinksListPage /> },
          { path: 'links/new', element: <LinkCreatePage /> },
          { path: 'links/bulk-import', element: <LinkBulkImportPage /> },
          { path: 'links/:linkId', element: <LinkDetailPage /> },
          { path: 'links/:linkId/edit', element: <LinkEditPage /> },
          { path: 'widgets/:type', element: <BannersListPage /> },
          { path: 'widgets/:type/new', element: <BannerEditorPage /> },
          { path: 'widgets/:type/:categoryId', element: <BannerDetailPage /> },
          { path: 'widgets/:type/:categoryId/edit', element: <BannerEditorPage /> },
          { path: 'widgets/:type/:categoryId/items/:itemId/report', element: <ItemReportPage /> },
          { path: 'mixpanel', element: <MixpanelConfigurePage /> },
          { path: 'mixpanel/cohorts', element: <MixpanelCohortsListPage /> },
          { path: 'mixpanel/cohorts/:cohortId', element: <MixpanelCohortDetailPage /> },
          { path: 'push-notifications', element: <ProjectPushNotificationsPage /> },
          // `new` is declared before `:campaignId` so it is not swallowed as an id.
          { path: 'push-notifications/new', element: <PushCampaignComposerPage /> },
          { path: 'push-notifications/:campaignId', element: <PushCampaignDetailPage /> },
          { path: 'segments', element: <SegmentsListPage /> },
          // Declared before `:segmentId`, or "new" is matched as an id.
          { path: 'segments/new', element: <SegmentEditorPage /> },
          { path: 'segments/:segmentId', element: <SegmentEditorPage /> },
          { path: 'email', element: <ProjectEmailPage /> },
          // Declared before any `email/:id`, or "new" would be read as an id.
          { path: 'email/new', element: <EmailCampaignComposerPage /> },
          { path: 'sms', element: <ProjectSmsPage /> },
          { path: 'sms/new', element: <SmsCampaignComposerPage /> },
          { path: 'whatsapp', element: <ProjectWhatsAppPage /> },
          { path: 'whatsapp/new', element: <WhatsAppCampaignComposerPage /> },
          { path: 'journeys', element: <JourneysListPage /> },
          // Declared before `:journeyId`, or "new" is matched as an id.
          { path: 'journeys/new', element: <JourneyEditorPage /> },
          { path: 'journeys/:journeyId', element: <JourneyEditorPage /> },
          { path: 'in-app-messages', element: <InAppMessagesCampaignListPage /> },
          { path: 'in-app-messages/new', element: <CampaignEditorPage /> },
          { path: 'in-app-messages/:id', element: <CampaignDetailPage /> },
          { path: 'in-app-messages/:id/edit', element: <CampaignEditorPage /> },
          { path: 'api-keys', element: <ProjectApiKeysPage /> },
          { path: 'webhooks', element: <ProjectWebhooksPage /> },
          { path: 'team', element: <ProjectMembersPage /> },
          { path: 'activity', element: <ProjectActivityPage /> },
          { path: 'settings', element: <ProjectSettingsPage /> },
        ],
      },
    ],
  },
  {
    path: '/:shortCode',
    element: <ShortRedirectPage />,
  },
]);
