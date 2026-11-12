import { useEffect, useRef, useState } from 'react';
import {
  endImpersonation,
  getEndedImpersonationTenantId,
  getImpersonation,
} from '@/lib/auth';
import { adminTenantUrl } from '@/lib/admin-app';

const CHECK_INTERVAL_MS = 1000;

function minutesLeft(expiresAt: string): number {
  return Math.max(1, Math.ceil((Date.parse(expiresAt) - Date.now()) / 60_000));
}

/**
 * Fixed rather than in flow because the app layouts pin themselves to the
 * viewport (a fixed sidebar and an `h-svh` inset), so the page cannot simply be
 * pushed down. The style block below hands each of them the height it takes.
 */
const RESERVE_SPACE = `
  body { padding-top: 2.5rem; }
  [data-slot="sidebar-wrapper"] { min-height: calc(100svh - 2.5rem); }
  [data-slot="sidebar-container"] { top: 2.5rem; height: calc(100svh - 2.5rem); }
  [data-slot="sidebar-inset"] { height: calc(100svh - 2.5rem); }
`;

export function ImpersonationBanner() {
  const [session] = useState(getImpersonation);
  const [minutes, setMinutes] = useState(() => (session ? minutesLeft(session.expiresAt) : 0));

  // Navigating again each tick would restart a load that takes longer than one.
  const leaving = useRef(false);

  function leave(tenantId: string) {
    if (leaving.current) return;
    leaving.current = true;
    // The admin app, a separate site: the staff member's own session there is untouched.
    window.location.assign(adminTenantUrl(tenantId));
  }

  useEffect(() => {
    function check() {
      const current = getImpersonation();
      if (current) {
        setMinutes(minutesLeft(current.expiresAt));
        return;
      }
      // Expired, or ended by a failed request: leave for the admin app, so nothing
      // of the tenant's stays in the query cache or on screen.
      const endedTenantId = getEndedImpersonationTenantId();
      if (endedTenantId) leave(endedTenantId);
    }

    check();
    if (!session) return;
    const timer = setInterval(check, CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [session]);

  if (!session) return null;

  function exit() {
    endImpersonation();
    leave(session!.tenant.id);
  }

  return (
    <>
      <style>{RESERVE_SPACE}</style>
      {/* pointer-events-auto: an open modal sets `pointer-events: none` on body. */}
      <div
        role="region"
        aria-label="Impersonation session"
        className="pointer-events-auto fixed inset-x-0 top-0 z-[60] flex h-10 items-center justify-between gap-3 bg-amber-400 px-4 text-sm font-medium text-black"
      >
        <p className="min-w-0 truncate">
          Viewing {session.tenant.email} as Super Admin · read-only · ends in {minutes} min
        </p>
        <button
          type="button"
          onClick={exit}
          className="shrink-0 rounded bg-black px-3 py-1 text-xs font-semibold text-white hover:bg-black/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
        >
          Exit
        </button>
      </div>
    </>
  );
}
