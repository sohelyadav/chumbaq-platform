import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ADMIN_APP_URL } from '@/lib/admin-app';
import { openHandoff } from '@/lib/impersonation-handoff';

/**
 * Where the admin app's "View as" lands, in a new tab: `/impersonate#code=...`. The code
 * is in the fragment so no server or log ever sees it in a URL; the page posts it to the
 * API and, on success, reloads into the tenant's dashboard read-only.
 */
export default function ImpersonatePage() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void openHandoff().then((message) => {
      if (live && message) setError(message);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      {error ? (
        <div role="alert" className="flex max-w-sm flex-col items-center gap-3 text-center">
          <AlertTriangle className="h-8 w-8 text-destructive" />
          <p className="text-sm">{error}</p>
          <Button variant="outline" asChild>
            <a href={ADMIN_APP_URL}>Back to the admin app</a>
          </Button>
        </div>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
          <Loader2 className="h-4 w-4 animate-spin" />
          Opening view-as...
        </p>
      )}
    </div>
  );
}
