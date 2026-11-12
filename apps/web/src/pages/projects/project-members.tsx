import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { Link } from 'react-router-dom';
import { Check, Copy, History, Mail, RotateCw, Trash2, UserPlus, Users, X } from 'lucide-react';
import type { CreatedInvitation, ProjectMember, ProjectRole } from '@chumbaq/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { SelectContent, SelectItem, SelectRoot as Select, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/use-toast';
import { useCurrentProject } from '@/contexts/project-context';
import { useAuth } from '@/hooks/use-auth';
import {
  reauthCancelled,
  serverMessage,
  useChangeMemberRole,
  useCreateInvitation,
  useProjectInvitations,
  useProjectMembers,
  useRemoveMember,
  useResendInvitation,
  useRevokeInvitation,
} from '@/hooks/use-project-members';
import { useProjects } from '@/hooks/use-projects';
import { copyText } from '@/lib/clipboard';
import {
  ROLE_DESCRIPTIONS,
  assignableRoles,
  atSeatLimit,
  can,
  canManageMember,
  roleLabel,
  seatLabel,
  seatRefusalStands,
} from '@/lib/project-role';

const SEAT_LIMIT_MESSAGE = 'Your plan has no free seats. Upgrade to invite teammates.';

function RoleBadge({ role }: { role: ProjectRole }) {
  return <Badge variant={role === 'member' ? 'outline' : 'default'}>{roleLabel(role)}</Badge>;
}

function RolePicker({
  value,
  roles,
  onChange,
  disabled,
  id,
}: {
  value: ProjectRole;
  roles: ProjectRole[];
  onChange: (role: ProjectRole) => void;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as ProjectRole)} disabled={disabled}>
      <SelectTrigger id={id} className="w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {roles.map((role) => (
          <SelectItem key={role} value={role}>
            {roleLabel(role)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Who is in the project, who is invited, and inviting someone. Everyone in the project
 * sees the list; changing it needs `members.manage`, and only owners may make or change
 * owners. The server checks all of it again.
 */
export default function ProjectMembersPage() {
  const { projectId, project } = useCurrentProject();
  const { user } = useAuth();
  const { data: projectsResponse, dataUpdatedAt: seatsUpdatedAt, refetch: refetchProjects } = useProjects();
  const manages = can(project, 'members.manage');
  const myRole = project?.role ?? 'member';

  const { data: membersResponse, isLoading } = useProjectMembers(projectId);
  const { data: invitations } = useProjectInvitations(projectId, manages);
  const changeRole = useChangeMemberRole(projectId);
  const removeMember = useRemoveMember(projectId);
  const createInvitation = useCreateInvitation(projectId);
  const resendInvitation = useResendInvitation(projectId);
  const revokeInvitation = useRevokeInvitation(projectId);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<ProjectRole>('member');
  const [inviteError, setInviteError] = useState<string | null>(null);
  // When the server last refused an invite for want of seats (ms), until something frees one.
  const [seatRefusedAt, setSeatRefusedAt] = useState<number | null>(null);
  // The link is in this state only, and only until the dialog closes: it is never shown again.
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [copied, setCopied] = useState(false);
  const [removing, setRemoving] = useState<ProjectMember | null>(null);

  // `meta.seats` is the caller's own billing account, so it only describes projects
  // billed to them. Elsewhere the server's refusal is what tells them.
  const seats = project?.isBillingOwner ? projectsResponse?.meta.seats : undefined;
  const refusalStands = seatRefusalStands(seatRefusedAt, seats, seatsUpdatedAt);
  const full = refusalStands || (seats ? atSeatLimit(seats) : false);

  // Fresh seats showing room bring the invite form back.
  useEffect(() => {
    if (seatRefusedAt !== null && !refusalStands) setSeatRefusedAt(null);
  }, [seatRefusedAt, refusalStands]);
  const roles = assignableRoles(myRole);

  const members = membersResponse?.members ?? [];

  const failed = (title: string, err: unknown) => {
    // Someone who cancelled the sign-in prompt knows why nothing happened.
    if (reauthCancelled(err)) return;
    toast({ title, description: serverMessage(err) ?? undefined, variant: 'destructive' });
  };

  const handleRoleChange = async (member: ProjectMember, role: ProjectRole) => {
    if (role === member.role) return;
    try {
      await changeRole.mutateAsync({ userId: member.userId, role });
      setSeatRefusedAt(null);
      toast({ title: 'Role changed', description: `${member.name || member.email} is now ${roleLabel(role).toLowerCase()}.` });
    } catch (err) {
      failed('Role not changed', err);
    }
  };

  const handleRemove = async () => {
    if (!removing) return;
    try {
      await removeMember.mutateAsync(removing.userId);
      setSeatRefusedAt(null);
      toast({ title: 'Removed from the project', description: removing.name || removing.email });
      setRemoving(null);
    } catch (err) {
      failed('Not removed', err);
    }
  };

  const showLink = (result: CreatedInvitation) => {
    setCopied(false);
    setCreated(result);
  };

  const handleInvite = async (event: React.FormEvent) => {
    event.preventDefault();
    setInviteError(null);
    const email = inviteEmail.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setInviteError('Enter an email address.');
      return;
    }
    try {
      const result = await createInvitation.mutateAsync({ email, role: inviteRole });
      setInviteEmail('');
      setInviteRole('member');
      showLink(result);
    } catch (err) {
      const message = serverMessage(err);
      if (message === SEAT_LIMIT_MESSAGE) {
        setSeatRefusedAt(Date.now());
        // So the count shown is the one the server just refused on.
        void refetchProjects();
      }
      else if (!reauthCancelled(err)) setInviteError(message ?? 'The invite was not sent. Try again.');
    }
  };

  const handleResend = async (invitationId: string) => {
    try {
      showLink(await resendInvitation.mutateAsync(invitationId));
    } catch (err) {
      failed('Invite not resent', err);
    }
  };

  const handleRevoke = async (invitationId: string) => {
    try {
      await revokeInvitation.mutateAsync(invitationId);
      setSeatRefusedAt(null);
      toast({ title: 'Invite cancelled' });
    } catch (err) {
      failed('Invite not cancelled', err);
    }
  };

  const handleCopy = async (text: string) => {
    if (!(await copyText(text))) {
      toast({
        title: 'Copy failed',
        description: 'Select the link and copy it yourself.',
        variant: 'destructive',
      });
      return;
    }
    setCopied(true);
  };

  const closeLink = () => {
    setCreated(null);
    setCopied(false);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Members</h1>
        <p className="text-muted-foreground mt-1">
          People who can open this project, and what their role lets them do.
        </p>
        {seats && <p className="text-sm text-muted-foreground mt-1">{seatLabel(seats)}</p>}
        {can(project, 'activity.view') && (
          <p className="text-sm mt-1">
            <Link to={`/projects/${projectId}/activity?group=team`} className="inline-flex items-center gap-1 text-primary hover:underline">
              <History className="h-3.5 w-3.5" />
              See who changed the team
            </Link>
          </p>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Members
            {membersResponse && (
              <span className="text-sm font-normal text-muted-foreground">({members.length})</span>
            )}
          </CardTitle>
          <CardDescription>
            Owners can do everything. Admins manage channels, keys and members, but not owners. Members
            work with links, campaigns and people.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded bg-muted" />
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Joined</TableHead>
                  {manages && <TableHead className="w-12" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((member) => {
                  const isMe = member.userId === user?.id;
                  // The billing owner stays an owner until billing moves; yourself, from settings.
                  const editable =
                    manages && !isMe && !member.isBillingOwner && canManageMember(myRole, member.role);
                  return (
                    <TableRow key={member.userId}>
                      <TableCell>
                        <p className="font-medium text-sm">
                          {member.name || member.email}
                          {isMe && <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>}
                        </p>
                        <p className="text-xs text-muted-foreground">{member.email}</p>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {editable ? (
                            <RolePicker
                              value={member.role}
                              roles={roles}
                              disabled={changeRole.isPending}
                              onChange={(role) => void handleRoleChange(member, role)}
                            />
                          ) : (
                            <RoleBadge role={member.role} />
                          )}
                          {member.isBillingOwner && <Badge variant="secondary">Billing owner</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {format(new Date(member.createdAt), 'MMM d, yyyy')}
                      </TableCell>
                      {manages && (
                        <TableCell>
                          {editable && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              aria-label={`Remove ${member.name || member.email}`}
                              onClick={() => setRemoving(member)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {manages && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5" />
              Pending invites
            </CardTitle>
            <CardDescription>
              Each link works once and for 7 days. Resending makes a new link and the old one stops working.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!invitations || invitations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No pending invites.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Invited by</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invitations.map((invitation) => {
                    const mayChange = canManageMember(myRole, invitation.role);
                    return (
                      <TableRow key={invitation.id}>
                        <TableCell className="text-sm">{invitation.email}</TableCell>
                        <TableCell>
                          <RoleBadge role={invitation.role} />
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {invitation.invitedBy?.name ?? 'Former member'}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {invitation.expired ? (
                            <Badge variant="outline">Expired</Badge>
                          ) : (
                            format(new Date(invitation.expiresAt), 'MMM d, yyyy')
                          )}
                        </TableCell>
                        <TableCell>
                          {mayChange && (
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                aria-label={`Resend the invite to ${invitation.email}`}
                                title="Resend"
                                disabled={resendInvitation.isPending}
                                onClick={() => void handleResend(invitation.id)}
                              >
                                <RotateCw className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 hover:text-destructive"
                                aria-label={`Cancel the invite to ${invitation.email}`}
                                title="Cancel invite"
                                disabled={revokeInvitation.isPending}
                                onClick={() => void handleRevoke(invitation.id)}
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {manages && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5" />
              Invite
            </CardTitle>
            <CardDescription>They join with this role once they accept with that email address.</CardDescription>
          </CardHeader>
          <CardContent>
            {full ? (
              <div role="status" className="rounded-md border bg-muted/40 px-4 py-3 text-sm">
                <p className="font-medium">Upgrade to invite teammates</p>
                <p className="text-muted-foreground mt-1">
                  Every seat on this plan is taken. Remove someone or cancel a pending invite to free one.
                </p>
              </div>
            ) : (
              <form onSubmit={handleInvite} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
                  <div className="space-y-2">
                    <Label htmlFor="invite-email">Email address</Label>
                    <Input
                      id="invite-email"
                      type="email"
                      autoComplete="off"
                      placeholder="colleague@example.com"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="invite-role">Role</Label>
                    <RolePicker id="invite-role" value={inviteRole} roles={roles} onChange={setInviteRole} />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[inviteRole]}</p>
                {inviteError && (
                  <p role="alert" className="text-sm text-destructive">
                    {inviteError}
                  </p>
                )}
                <Button type="submit" disabled={createInvitation.isPending}>
                  {createInvitation.isPending ? 'Inviting...' : 'Send invite'}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={!!created} onOpenChange={(open) => !open && closeLink()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite link for {created?.invitation.email}</DialogTitle>
            <DialogDescription>
              {created?.emailSent
                ? 'Email sent. You can also share this link yourself.'
                : 'Email not sent — copy the link'}
            </DialogDescription>
          </DialogHeader>
          {created?.emailSkipped === 'daily_limit' && (
            <p className="text-sm text-muted-foreground">
              This account has sent its invite emails for today, so share the link yourself.
            </p>
          )}
          {created && (
            <div className="flex items-center gap-2">
              <code className="flex-1 p-3 bg-muted rounded text-sm font-mono break-all select-all">
                {created.inviteUrl}
              </code>
              <Button
                variant="outline"
                size="icon"
                aria-label="Copy invite link"
                onClick={() => void handleCopy(created.inviteUrl)}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            This is the only time the link is shown. It works once, for 7 days, and only for that email address.
          </p>
          <DialogFooter>
            <Button onClick={closeLink} className="w-full">
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {removing?.name || removing?.email}?</DialogTitle>
            <DialogDescription>
              They lose access to this project at once. Pending invites they sent are cancelled.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleRemove()} disabled={removeMember.isPending}>
              {removeMember.isPending ? 'Removing...' : 'Remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
