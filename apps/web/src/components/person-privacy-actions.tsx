import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/use-toast';
import { downloadPersonExport, useErasePerson } from '@/hooks/use-users';
import { getImpersonation } from '@/lib/auth';

interface Props {
  projectId: string;
  personId: string;
  /** What the person must type to confirm: their user id, or their device id when anonymous. */
  confirmationText: string;
  /** Set when the person is signed in: the erasure then covers every device with this user id. */
  externalUserId: string | null;
}


/**
 * Export and erasure for one person, for the project owner's data-protection
 * duties (DPDP Act 2023). Hidden while staff view as the tenant, which the API
 * refuses anyway.
 */
export function PersonPrivacyActions({ projectId, personId, confirmationText, externalUserId }: Props) {
  const navigate = useNavigate();
  const erase = useErasePerson(projectId, personId);
  const [exporting, setExporting] = useState(false);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');

  if (getImpersonation()) return null;

  const handleExport = async () => {
    setExporting(true);
    try {
      const data = await downloadPersonExport(projectId, personId);
      toast({
        title: 'Export downloaded',
        description: data.truncated
          ? `Some sections hold more than ${data.rowCapPerSection.toLocaleString()} rows; the file has the newest of each.`
          : undefined,
      });
    } catch {
      toast({ title: 'Export failed', variant: 'destructive' });
    } finally {
      setExporting(false);
    }
  };

  const handleErase = async () => {
    try {
      const result = await erase.mutateAsync();
      const rows = Object.values(result.counts).reduce((sum, n) => sum + n, 0);
      // Some counts are rows updated (campaign lists, attribution splits), not deleted.
      toast({
        title: result.result === 'erased' ? 'Person deleted' : 'Nothing left to delete',
        description:
          result.result === 'erased'
            ? `${rows.toLocaleString()} records deleted or updated. This request is logged.`
            : undefined,
      });
      setOpen(false);
      navigate(`/projects/${projectId}/users`);
    } catch (error) {
      const message = (error as { response?: { data?: { message?: unknown } } }).response?.data?.message;
      toast({
        title: 'Could not delete this person',
        description: typeof message === 'string' ? message : undefined,
        variant: 'destructive',
      });
    }
  };

  const confirmed = typed.trim() === confirmationText;

  return (
    <>
      <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting}>
        <Download className="mr-1.5 h-3.5 w-3.5" />
        {exporting ? 'Exporting...' : 'Export data'}
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="text-red-600 hover:text-red-700"
        onClick={() => {
          setTyped('');
          setOpen(true);
        }}
      >
        <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete person
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Delete this person and their data?</DialogTitle>
            <DialogDescription>This cannot be undone.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              This deletes this device
              {externalUserId ? (
                <>
                  {' '}and every device signed in as{' '}
                  <span className="font-mono font-medium">{externalUserId}</span>
                </>
              ) : null}
              .
            </p>
            <div>
              <p className="font-medium">Deleted from Chumbaq</p>
              <p className="text-muted-foreground">
                Every device linked to this person, their profile, traits and consent, events, clicks,
                conversions, attribution, push tokens, message delivery records for every channel, in-app
                impressions, journey progress, segment membership, and Mixpanel cohort membership (which comes
                back at the next cohort sync unless you delete the person in Mixpanel too).
              </p>
            </div>
            <div>
              <p className="font-medium">Kept</p>
              <p className="text-muted-foreground">
                Opt-outs (unsubscribes, bounces, complaints), as one-way hashes, so the person is not messaged
                again if their address is added later. An opt-out or delivery failure for an address another
                record in this project also holds, as it is. Campaign totals, as anonymous numbers. A log entry
                recording that you made this request, with their ids stored only as keyed hashes.
              </p>
            </div>
            <div>
              <p className="font-medium">Not deleted by Chumbaq</p>
              <p className="text-muted-foreground">
                Other devices shown on this page that are not signed in as this user, and events recorded under
                their ids. Events recorded before sign-in that were never linked to this user. History recorded on
                a shared device before this user signed in goes with the device, not the user. Nothing proves these
                are theirs, so they are kept.
              </p>
              <p className="text-muted-foreground">
                Database backups until they expire; anything already sent to your providers and tools (FCM,
                APNs, SES, Resend, Brevo, Twilio, Meta, Gupshup, Interakt, Mixpanel, your webhooks), which
                you must delete there; server logs. If your app is still running on their device it will send
                new data: sign them out or reset the SDK too.
              </p>
            </div>
            <div className="space-y-1.5 pt-1">
              <Label htmlFor="erase-confirm">
                Type <span className="font-mono">{confirmationText}</span> to confirm
              </Label>
              <Input
                id="erase-confirm"
                autoComplete="off"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleErase} disabled={!confirmed || erase.isPending}>
              {erase.isPending ? 'Deleting...' : 'Delete person'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
