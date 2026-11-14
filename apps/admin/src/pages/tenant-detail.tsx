import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { format } from 'date-fns';
import { ArrowLeft, Eye, FolderKanban, KeyRound, ShieldCheck, ShieldOff, RotateCcw } from 'lucide-react';
import type {
  AdminAuditAction,
  AdminTenantDetail,
  FactorResetVerificationMethod,
  ImpersonationHandoff,
} from '@chumbaq/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/use-toast';
import {
  adminErrorMessage,
  httpStatus,
  useAdminFactorReset,
  useAdminTenant,
  useCancelFactorReset,
  useImpersonateTenant,
  useRequestFactorReset,
  useReactivateTenant,
  type FactorResetVerificationInput,
  useSetProjectLimit,
  useSetSeatLimit,
  useSuspendTenant,
} from '@/hooks/use-admin-tenants';
import { parseProjectLimitInput, projectCountLabel, seatCountLabel } from '@/lib/project-limit';

const REASON_MIN = 10;
const REASON_MAX = 500;

const AUDIT_LABELS: Record<AdminAuditAction, string> = {
  'tripwire.created': 'Trap made',
  'tripwire.revoked': 'Trap switched off',
  'incident.recorded': 'Incident recorded',
  'incident.reported': 'Incident marked reported to CERT-In',
  'incident.note_added': 'Incident note added',
  'incident.closed': 'Incident closed',
  'security_contact.updated': 'Security contact changed',
  'tenant.suspended': 'Suspended',
  'tenant.reactivated': 'Reactivated',
  'tenant.impersonated': 'Viewed as tenant',
  'super_admin.granted': 'Super admin granted',
  'super_admin.revoked': 'Super admin revoked',
  'super_admin.passkeys_reset': 'Passkeys reset by CLI',
  'account.factors_reset': 'Second factors reset',
  'tenant.viewed': 'Viewed by staff',
  'audit_log.exported': 'Audit log exported',
  'tenants.exported': 'Tenants list exported',
  'account.factors_reset_requested': 'Second factor reset requested',
  'account.factors_reset_cancelled': 'Second factor reset cancelled',
  'account.password_reset_refused': 'Password reset refused after factor reset',
  'account.password_reset_link_issued': 'Password reset link issued by CLI',
  'account.password_reset_link_cancelled': 'Password reset link cancelled',
  'account.password_reset_link_void_failed': 'Sign-in could not cancel a password reset link',
  'account.project_limit_changed': 'Project limit changed',
  'account.seat_limit_changed': 'Seat limit changed',
  'staff.signed_in': 'Signed in',
  'staff.sign_in_failed': 'Failed sign-in',
  'staff.signed_out': 'Signed out',
  'staff.session_revoked': 'Session ended',
  'staff.enrolment_started': 'Started sign-in setup',
  'staff.enrolment_allowed': 'Enrolment code issued',
  'staff.factor_added': 'Added a sign-in method',
  'staff.factor_removed': 'Removed a sign-in method',
  'tenant.impersonation_exchanged': 'View-as opened',
  'tenant.impersonation_refused': 'View-as link refused',
};

/** Mirrors `FACTOR_RESET_VERIFICATION_METHODS` in the API. Email is never one. */
const VERIFICATION_METHOD_LABELS: Record<FactorResetVerificationMethod, string> = {
  video_call: 'Video call',
  government_id: 'Government ID',
  phone_call_known_number: 'Phone call to a number on file',
  billing_record: 'Billing record',
  other: 'Other',
};
const VERIFICATION_NOTES_MIN = 10;
const VERIFICATION_NOTES_MAX = 1000;

function formatDateTime(value: string): string {
  return format(new Date(value), 'MMM d, yyyy HH:mm');
}

interface ReasonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  reasonLabel: string;
  confirmLabel: string;
  destructive?: boolean;
  /** When set, the action stays disabled until this exact text is typed. */
  confirmationText?: string;
  /** A second, separately recorded justification, with the same length rule as the reason. */
  secondReason?: { label: string; hint: ReactNode };
  /** Asks how the person's identity was checked, other than by email. */
  verification?: boolean;
  onSubmit: (reason: string, secondReason?: string, verification?: FactorResetVerificationInput) => Promise<void>;
}

function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  reasonLabel,
  confirmLabel,
  destructive,
  confirmationText,
  secondReason,
  verification,
  onSubmit,
}: ReasonDialogProps) {
  const [reason, setReason] = useState('');
  const [second, setSecond] = useState('');
  const [method, setMethod] = useState<FactorResetVerificationMethod | ''>('');
  const [notes, setNotes] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // State only updates on the next render, so two quick clicks would both see `false`.
  const inFlight = useRef(false);

  useEffect(() => {
    if (open) {
      setReason('');
      setSecond('');
      setMethod('');
      setNotes('');
      setConfirmation('');
      setError(null);
    }
  }, [open]);

  const trimmedLength = reason.trim().length;
  const reasonValid = trimmedLength >= REASON_MIN && trimmedLength <= REASON_MAX;
  const secondLength = second.trim().length;
  const secondValid = !secondReason || (secondLength >= REASON_MIN && secondLength <= REASON_MAX);
  const notesLength = notes.trim().length;
  const verificationValid =
    !verification ||
    (method !== '' && notesLength >= VERIFICATION_NOTES_MIN && notesLength <= VERIFICATION_NOTES_MAX);
  const confirmed = confirmationText === undefined || confirmation.trim() === confirmationText;
  const canSubmit = reasonValid && secondValid && verificationValid && confirmed && !submitting;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(
        reason.trim(),
        secondReason ? second.trim() : undefined,
        verification && method !== '' ? { method, notes: notes.trim() } : undefined,
      );
      onOpenChange(false);
    } catch (err) {
      setError(adminErrorMessage(err, 'That did not work. Nothing was changed.'));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2">{description}</div>
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="admin-action-reason">{reasonLabel}</Label>
            <Textarea
              id="admin-action-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              disabled={submitting}
              aria-describedby="admin-action-reason-count"
            />
            <p
              id="admin-action-reason-count"
              className={`text-xs ${trimmedLength > REASON_MAX ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              {trimmedLength}/{REASON_MAX} characters, at least {REASON_MIN}. Recorded in the audit log.
            </p>
          </div>

          {secondReason && (
            <div className="grid gap-2">
              <Label htmlFor="admin-action-second-reason">{secondReason.label}</Label>
              <Textarea
                id="admin-action-second-reason"
                value={second}
                onChange={(e) => setSecond(e.target.value)}
                rows={3}
                disabled={submitting}
                aria-describedby="admin-action-second-reason-hint"
              />
              <p
                id="admin-action-second-reason-hint"
                className={`text-xs ${secondLength > REASON_MAX ? 'text-destructive' : 'text-muted-foreground'}`}
              >
                {secondReason.hint} {secondLength}/{REASON_MAX} characters, at least {REASON_MIN}.
              </p>
            </div>
          )}

          {verification && (
            <>
              <div className="grid gap-2">
                <Label htmlFor="admin-action-verification-method">How you verified who is asking</Label>
                <Select
                  value={method}
                  onValueChange={(value) => setMethod(value as FactorResetVerificationMethod)}
                  disabled={submitting}
                >
                  <SelectTrigger id="admin-action-verification-method">
                    <SelectValue placeholder="Choose one" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(VERIFICATION_METHOD_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Not email: whoever is asking may control the mailbox.</p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="admin-action-verification-notes">What you checked</Label>
                <Textarea
                  id="admin-action-verification-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  disabled={submitting}
                  placeholder="For example: called the number on their invoice and they confirmed the last payment."
                  aria-describedby="admin-action-verification-notes-count"
                />
                <p
                  id="admin-action-verification-notes-count"
                  className={`text-xs ${notesLength > VERIFICATION_NOTES_MAX ? 'text-destructive' : 'text-muted-foreground'}`}
                >
                  {notesLength}/{VERIFICATION_NOTES_MAX} characters, at least {VERIFICATION_NOTES_MIN}. Recorded in the
                  audit log.
                </p>
              </div>
            </>
          )}

          {confirmationText !== undefined && (
            <div className="grid gap-2">
              <Label htmlFor="admin-action-confirmation" className="block break-all">
                Type {confirmationText} to confirm
              </Label>
              <Input
                id="admin-action-confirmation"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="off"
                disabled={submitting}
              />
            </div>
          )}

          {error && (
            <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={!canSubmit}>
              {submitting ? 'Working...' : confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Staff's override of the account's project limit; blank returns it to the default. */
function ProjectLimitDialog({
  tenant,
  open,
  onOpenChange,
}: {
  tenant: AdminTenantDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const setLimit = useSetProjectLimit(tenant.id);
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setText(tenant.projectLimit === null ? '' : String(tenant.projectLimit));
    setReason('');
    setError(null);
  }, [open, tenant.projectLimit]);

  const parsed = parseProjectLimitInput(text);
  const reasonLength = reason.trim().length;
  const reasonValid = reasonLength >= REASON_MIN && reasonLength <= REASON_MAX;
  const canSubmit = parsed.ok && reasonValid && !submitting;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || !parsed.ok) return;
    setSubmitting(true);
    setError(null);
    try {
      await setLimit.mutateAsync({ projectLimit: parsed.value, reason: reason.trim() });
      toast({ title: 'Project limit saved' });
      onOpenChange(false);
    } catch (err) {
      setError(adminErrorMessage(err, 'That did not work. Nothing was changed.'));
    } finally {
      setSubmitting(false);
    }
  }

  const defaultLimit = tenant.projectLimit === null ? tenant.effectiveProjectLimit : null;

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Project limit</DialogTitle>
            <DialogDescription>
              How many projects this account can have. Leave blank for the default
              {defaultLimit !== null ? ` (${defaultLimit})` : ''}. Lowering it deletes nothing; it only
              stops new projects.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="admin-project-limit">Limit</Label>
            <Input
              id="admin-project-limit"
              inputMode="numeric"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Default"
              aria-invalid={!parsed.ok}
            />
            {!parsed.ok && <p className="text-xs text-destructive">{parsed.error}</p>}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="admin-project-limit-reason">Reason</Label>
            <Textarea
              id="admin-project-limit-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={REASON_MAX}
              rows={3}
            />
            <p className="text-xs text-muted-foreground">
              {reasonLength}/{REASON_MAX}, at least {REASON_MIN} characters.
            </p>
          </div>
          {error && (
            <div role="alert" className="text-sm text-destructive">
              {error}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? 'Working...' : 'Save limit'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Staff's override of the account's seat limit; blank returns it to the default. */
function SeatLimitDialog({
  tenant,
  open,
  onOpenChange,
}: {
  tenant: AdminTenantDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const setLimit = useSetSeatLimit(tenant.id);
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setText(tenant.seatLimit === null ? '' : String(tenant.seatLimit));
    setReason('');
    setError(null);
  }, [open, tenant.seatLimit]);

  const parsed = parseProjectLimitInput(text);
  const reasonLength = reason.trim().length;
  const reasonValid = reasonLength >= REASON_MIN && reasonLength <= REASON_MAX;
  const canSubmit = parsed.ok && reasonValid && !submitting;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || !parsed.ok) return;
    setSubmitting(true);
    setError(null);
    try {
      await setLimit.mutateAsync({ seatLimit: parsed.value, reason: reason.trim() });
      toast({ title: 'Seat limit saved' });
      onOpenChange(false);
    } catch (err) {
      setError(adminErrorMessage(err, 'That did not work. Nothing was changed.'));
    } finally {
      setSubmitting(false);
    }
  }

  const defaultLimit = tenant.seatLimit === null ? tenant.effectiveSeatLimit : null;

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Seat limit</DialogTitle>
            <DialogDescription>
              How many people can be on this account's projects, counting invitations. Leave blank for the
              default{defaultLimit !== null ? ` (${defaultLimit})` : tenant.seatLimit === null ? ' (no limit)' : ''}.
              Lowering it removes nobody; it only stops new invitations.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="admin-seat-limit">Limit</Label>
            <Input
              id="admin-seat-limit"
              inputMode="numeric"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Default"
              aria-invalid={!parsed.ok}
            />
            {!parsed.ok && <p className="text-xs text-destructive">{parsed.error}</p>}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="admin-seat-limit-reason">Reason</Label>
            <Textarea
              id="admin-seat-limit-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={REASON_MAX}
              rows={3}
            />
            <p className="text-xs text-muted-foreground">
              {reasonLength}/{REASON_MAX}, at least {REASON_MIN} characters.
            </p>
          </div>
          {error && (
            <div role="alert" className="text-sm text-destructive">
              {error}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? 'Working...' : 'Save limit'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProjectsCardHeader({ tenant }: { tenant: AdminTenantDetail }) {
  const [open, setOpen] = useState(false);
  const [seatsOpen, setSeatsOpen] = useState(false);
  return (
    <CardHeader className="flex flex-row items-center justify-between space-y-0">
      <div>
        <CardTitle className="text-base">Projects</CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          {projectCountLabel(tenant.projectCount, tenant.effectiveProjectLimit)}
          {tenant.projectLimit === null ? ' (default limit)' : ' (limit set by staff)'}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Seats: {seatCountLabel(tenant.seatsUsed, tenant.effectiveSeatLimit)}
          {tenant.seatLimit === null
            ? tenant.effectiveSeatLimit === null
              ? ''
              : ' (default limit)'
            : ' (limit set by staff)'}
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          Change limit
        </Button>
        <Button variant="outline" size="sm" onClick={() => setSeatsOpen(true)}>
          Change seat limit
        </Button>
      </div>
      <ProjectLimitDialog tenant={tenant} open={open} onOpenChange={setOpen} />
      <SeatLimitDialog tenant={tenant} open={seatsOpen} onOpenChange={setSeatsOpen} />
    </CardHeader>
  );
}

/**
 * The second step of view-as. The link opens on the person's own click rather than from
 * script after the request, which pop-up blockers would stop. The code in it works once
 * and for 60 seconds, so the dialog closes itself when it lapses.
 */
function ViewAsReadyDialog({ handoff, onClose }: { handoff: ImpersonationHandoff | null; onClose: () => void }) {
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (!handoff) return;
    const tick = () => {
      const left = Math.ceil((Date.parse(handoff.expiresAt) - Date.now()) / 1000);
      if (left <= 0) onClose();
      else setSecondsLeft(left);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [handoff, onClose]);

  return (
    <Dialog open={!!handoff} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>View as {handoff?.tenant.email}</DialogTitle>
          <DialogDescription>
            The customer app opens in a new tab, read-only, for 30 minutes. This link works once,
            for the next {secondsLeft} seconds.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {handoff && (
            <Button asChild>
              {/* Closed after the click has opened the tab: the code is spent either way. */}
              <a href={handoff.url} target="_blank" rel="noopener noreferrer" onClick={() => setTimeout(onClose, 0)}>
                <Eye className="h-4 w-4" />
                Open view-as
              </a>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type TenantAction = 'suspend' | 'reactivate' | 'impersonate';

function TenantActions({ tenant }: { tenant: AdminTenantDetail }) {
  const [activeDialog, setActiveDialog] = useState<TenantAction | null>(null);
  const suspend = useSuspendTenant(tenant.id);
  const reactivate = useReactivateTenant(tenant.id);
  const impersonate = useImpersonateTenant(tenant.id);
  const [handoff, setHandoff] = useState<ImpersonationHandoff | null>(null);
  const closeHandoff = useCallback(() => setHandoff(null), []);

  const suspended = tenant.status === 'suspended';
  const viewAsBlockedBy = tenant.isSuperAdmin
    ? 'Super admins cannot be viewed as.'
    : suspended
      ? 'Suspended tenants cannot be viewed as. Reactivate the account first.'
      : null;

  const dialogProps = (action: TenantAction) => ({
    open: activeDialog === action,
    onOpenChange: (open: boolean) => setActiveDialog(open ? action : null),
  });

  return (
    <div className="flex flex-col gap-2 sm:items-end">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={!!viewAsBlockedBy} onClick={() => setActiveDialog('impersonate')}>
          <Eye className="h-4 w-4" />
          View as tenant
        </Button>
        {suspended ? (
          <Button variant="outline" onClick={() => setActiveDialog('reactivate')}>
            <RotateCcw className="h-4 w-4" />
            Reactivate
          </Button>
        ) : (
          <Button variant="destructive" disabled={tenant.isSuperAdmin} onClick={() => setActiveDialog('suspend')}>
            <ShieldOff className="h-4 w-4" />
            Suspend
          </Button>
        )}
      </div>
      {tenant.isSuperAdmin && !suspended && (
        <p className="text-xs text-muted-foreground">Super admins cannot be suspended.</p>
      )}
      {viewAsBlockedBy && <p className="text-xs text-muted-foreground">{viewAsBlockedBy}</p>}

      <ReasonDialog
        {...dialogProps('suspend')}
        title="Suspend this tenant?"
        description={
          <>
            <p>This takes effect immediately and can be reversed by reactivating.</p>
            <ul className="list-disc space-y-1 pl-4">
              <li>Their dashboard is locked: login fails and live sessions end.</li>
              <li>Their short links stop redirecting and show an unavailable page.</li>
              <li>All sends stop: push, email, SMS, WhatsApp, journeys and in-app messages.</li>
              <li>SDK data keeps being collected, so nothing is lost while suspended.</li>
            </ul>
          </>
        }
        reasonLabel="Reason"
        confirmLabel="Suspend tenant"
        destructive
        confirmationText={tenant.email}
        onSubmit={async (reason) => {
          await suspend.mutateAsync(reason);
          toast({ title: 'Tenant suspended' });
        }}
      />

      <ReasonDialog
        {...dialogProps('reactivate')}
        title="Reactivate this tenant?"
        description={
          <p>
            They can log in again, their short links redirect again, and sends and journeys resume.
          </p>
        }
        reasonLabel="Reason"
        confirmLabel="Reactivate tenant"
        onSubmit={async (reason) => {
          await reactivate.mutateAsync(reason);
          toast({ title: 'Tenant reactivated' });
        }}
      />

      <ReasonDialog
        {...dialogProps('impersonate')}
        title="View as this tenant?"
        description={
          <p>
            View as opens the customer app in a new tab, read-only, for 30 minutes. It is
            recorded in the audit log with your reason, and ends if you sign out here.
          </p>
        }
        reasonLabel="Reason"
        confirmLabel="Start read-only session"
        onSubmit={async (reason) => {
          setHandoff(await impersonate.mutateAsync(reason));
        }}
      />

      <ViewAsReadyDialog handoff={handoff} onClose={closeHandoff} />
    </div>
  );
}

/** Mirrors `PASSWORD_RESET_WINDOW_DAYS` in the API, which is what actually decides. */
const PASSWORD_RESET_WINDOW_DAYS = 14;

/**
 * For a tenant who has lost every factor and recovery code. Nothing is removed until the
 * wait is over, and the wait starts only once the owner's warning email has gone, so
 * whoever asked cannot be someone else without the owner having days to say so.
 */
function SecondFactorResetCard({ tenant }: { tenant: AdminTenantDetail }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { data: state, isLoading } = useAdminFactorReset(tenant.id);
  const request = useRequestFactorReset(tenant.id);
  const cancel = useCancelFactorReset(tenant.id);

  // Staff keys come back only through the CLI.
  if (tenant.isSuperAdmin || isLoading || !state) return null;
  const pending = state.pending;
  const lastReset = state.lastPasswordResetAt;
  const recentReset =
    lastReset !== null && Date.now() - new Date(lastReset).getTime() < PASSWORD_RESET_WINDOW_DAYS * 86_400_000;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4" />
          Second factors
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {pending ? (
          <>
            {pending.noticeSentAt ? (
              <p className="font-medium">
                Reset scheduled for {formatDateTime(pending.executeAfter)}, unless the owner cancels it or signs
                in with a factor first. The owner was warned by email on {formatDateTime(pending.noticeSentAt)}.
              </p>
            ) : (
              <p role="alert" className="rounded-md bg-destructive/10 p-3 font-medium text-destructive">
                The warning email to the owner has not gone out yet, so the wait has not started and nothing will
                be removed. It is retried every few minutes; check account email in platform health.
              </p>
            )}
            <p className="text-muted-foreground">
              Requested by {pending.requestedByEmail} on {formatDateTime(pending.requestedAt)}:
            </p>
            <p className="whitespace-pre-wrap break-words text-muted-foreground">{pending.reason}</p>
            {pending.verificationMethod ? (
              <>
                <p className="text-muted-foreground">
                  Identity checked by {VERIFICATION_METHOD_LABELS[pending.verificationMethod].toLowerCase()}:
                </p>
                <p className="whitespace-pre-wrap break-words text-muted-foreground">{pending.verificationNotes}</p>
              </>
            ) : (
              <p className="text-muted-foreground">No identity check was recorded for this request.</p>
            )}
            {pending.passwordResetOverride && (
              <>
                <p className="text-muted-foreground">
                  Started although the password had been reset recently, because:
                </p>
                <p className="whitespace-pre-wrap break-words text-muted-foreground">
                  {pending.passwordResetOverride}
                </p>
              </>
            )}
            <Button
              variant="outline"
              disabled={cancel.isPending}
              onClick={async () => {
                try {
                  await cancel.mutateAsync();
                  toast({ title: 'Reset cancelled' });
                } catch (err) {
                  toast({
                    title: 'Could not cancel',
                    description: adminErrorMessage(err, 'Nothing was changed.'),
                    variant: 'destructive',
                  });
                }
              }}
            >
              {cancel.isPending ? 'Cancelling...' : 'Cancel reset'}
            </Button>
          </>
        ) : !state.hasFactors ? (
          <p className="text-muted-foreground">This account has no second factors, so there is nothing to reset.</p>
        ) : !state.emailConfigured ? (
          <p className="text-muted-foreground">
            Account email is not set up, so the owner cannot be warned and no reset can be started.
          </p>
        ) : (
          <>
            <p className="text-muted-foreground">
              If the owner has lost every passkey, authenticator and recovery code, their factors can be
              removed after a waiting period. Be sure who is asking first.
            </p>
            {lastReset && (
              <p className={recentReset ? 'font-medium text-destructive' : 'text-muted-foreground'}>
                Password last reset {formatDateTime(lastReset)}.
              </p>
            )}
            <Button variant="outline" onClick={() => setDialogOpen(true)}>
              Reset second factors
            </Button>
          </>
        )}
      </CardContent>

      <ReasonDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title="Reset this tenant's second factors?"
        description={
          <>
            <p>Nothing is removed straight away.</p>
            <ul className="list-disc space-y-1 pl-4">
              <li>
                The owner is emailed now, with the time it will happen and how to cancel. The wait starts once
                that email has gone.
              </li>
              <li>
                It is cancelled if they sign in with a factor, cancel it in their settings, or the password is
                reset.
              </li>
              <li>
                Afterwards every passkey, authenticator and recovery code is gone, every device is signed out,
                and the password alone signs in.
              </li>
            </ul>
            <p>
              {lastReset
                ? `The password was last reset ${formatDateTime(lastReset)}.`
                : 'There is no record of a password reset on this account.'}
            </p>
            {recentReset && (
              <p role="alert" className="rounded-md bg-destructive/10 p-3 text-destructive">
                That was within the last {PASSWORD_RESET_WINDOW_DAYS} days. Whoever reset it controls the mailbox
                and may not be the owner: removing the factors as well would hand them the account.
              </p>
            )}
            <p>
              Confirm who is asking by some means other than email first. For {PASSWORD_RESET_WINDOW_DAYS} days
              afterwards, the password cannot be reset by email or by a team admin.
            </p>
          </>
        }
        reasonLabel="Why they need it"
        confirmLabel="Schedule reset"
        destructive
        verification
        confirmationText={tenant.email}
        secondReason={
          recentReset
            ? {
                label: 'Why go ahead despite the recent password reset',
                hint: 'Recorded in the audit log and shown with the pending reset.',
              }
            : undefined
        }
        onSubmit={async (reason, passwordResetOverride, verification) => {
          if (!verification) return;
          const result = await request.mutateAsync({ reason, passwordResetOverride, verification });
          toast(
            result.pending?.noticeSentAt
              ? { title: 'Reset scheduled', description: 'The owner has been emailed.' }
              : {
                  title: 'Reset waiting on the warning email',
                  description: 'The owner could not be emailed yet. The wait starts once they are.',
                  variant: 'destructive',
                },
          );
        }}
      />
    </Card>
  );
}

export default function TenantDetailPage() {
  const { tenantId } = useParams<{ tenantId: string }>();
  const { data: tenant, isLoading, isError, error } = useAdminTenant(tenantId);
  const { state } = useLocation();
  const tenantsSearch = (state as { tenantsSearch?: string } | null)?.tenantsSearch;

  const backLink = (
    <Button variant="ghost" size="sm" asChild className="-ml-2">
      {/* Back to the same search, filter and page the list was on. */}
      <Link to={tenantsSearch ? `/tenants?${tenantsSearch}` : '/tenants'}>
        <ArrowLeft className="h-4 w-4" />
        Tenants
      </Link>
    </Button>
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        {backLink}
        <div className="h-16 animate-pulse rounded bg-muted" />
        <div className="h-48 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  if (isError || !tenant) {
    const status = httpStatus(error);
    return (
      <div className="space-y-6">
        {backLink}
        <p role="alert" className="py-16 text-center text-sm text-muted-foreground">
          {status === 404
            ? 'This tenant does not exist.'
            : status === 403
              ? 'You do not have access to this tenant.'
              : adminErrorMessage(error, 'This tenant could not be loaded.')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {backLink}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold break-words">{tenant.name}</h1>
          <p className="text-muted-foreground mt-1 break-all">{tenant.email}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant={tenant.status === 'suspended' ? 'destructive' : 'secondary'}>{tenant.status}</Badge>
            {tenant.isSuperAdmin && (
              <Badge variant="outline">
                <ShieldCheck className="h-3 w-3" />
                Super admin
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">
              Joined {format(new Date(tenant.createdAt), 'MMM d, yyyy')}
            </span>
          </div>
        </div>
        <TenantActions tenant={tenant} />
      </div>

      {tenant.status === 'suspended' && (
        <Card className="border-destructive/40">
          <CardContent className="space-y-1 p-4 text-sm">
            <p className="font-medium text-destructive">
              Suspended{tenant.suspendedAt ? ` on ${formatDateTime(tenant.suspendedAt)}` : ''}
            </p>
            <p className="whitespace-pre-wrap break-words text-muted-foreground">
              {tenant.suspendedReason || 'No reason recorded.'}
            </p>
          </CardContent>
        </Card>
      )}

      <SecondFactorResetCard tenant={tenant} />

      <Card>
        <ProjectsCardHeader tenant={tenant} />
        <CardContent className="p-0">
          {tenant.projects.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              <FolderKanban className="mx-auto mb-3 h-10 w-10 opacity-50" />
              <p className="text-sm">This tenant owns no projects.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Project</TableHead>
                  <TableHead>Domain</TableHead>
                  <TableHead className="text-right">Links</TableHead>
                  <TableHead className="text-right">Identities</TableHead>
                  <TableHead className="text-right">Clicks (30d)</TableHead>
                  <TableHead className="text-right">Active API keys</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenant.projects.map((project) => (
                  <TableRow key={project.id}>
                    <TableCell className="max-w-[240px] truncate text-sm font-medium">{project.name}</TableCell>
                    <TableCell className="max-w-[200px] truncate text-sm text-muted-foreground">
                      {project.domain ?? '-'}
                    </TableCell>
                    <TableCell className="text-right text-sm">{project.linkCount.toLocaleString()}</TableCell>
                    <TableCell className="text-right text-sm">{project.identityCount.toLocaleString()}</TableCell>
                    <TableCell className="text-right text-sm">{project.clicksLast30d.toLocaleString()}</TableCell>
                    <TableCell className="text-right text-sm">{project.activeApiKeyCount.toLocaleString()}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {format(new Date(project.createdAt), 'MMM d, yyyy')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Recent audit trail</CardTitle>
          {/* Staff views are left off this list and shown in the full log. */}
          <Link
            to={`/audit-log?targetId=${tenant.id}`}
            className="text-sm text-primary hover:underline"
          >
            Full history, including staff views
          </Link>
        </CardHeader>
        <CardContent className="p-0">
          {tenant.recentAudit.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">Nothing recorded for this tenant yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenant.recentAudit.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {formatDateTime(entry.createdAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm">
                      {AUDIT_LABELS[entry.action] ?? entry.action}
                    </TableCell>
                    <TableCell className="text-sm">{entry.actorEmail}</TableCell>
                    <TableCell className="min-w-[240px] whitespace-pre-wrap break-words text-sm text-muted-foreground">
                      {entry.reason ?? '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
