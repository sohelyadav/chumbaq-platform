import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowLeft, LogOut, Trash2, Wallet } from 'lucide-react';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { SelectContent, SelectItem, SelectRoot as Select, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useProject, useUpdateProject, useDeleteProject } from '@/hooks/use-projects';
import {
  reauthCancelled,
  serverMessage,
  useAcceptBilling,
  useCancelBillingOffer,
  useDeclineBilling,
  useLeaveProject,
  useOfferBilling,
  useProjectMembers,
} from '@/hooks/use-project-members';
import { useAuth } from '@/hooks/use-auth';
import { can } from '@/lib/project-role';
import { toast } from '@/components/ui/use-toast';

const projectSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  domain: z.string().min(1, 'Domain is required'),
  webFallbackUrl: z.string().url().optional().or(z.literal('')),
  iosBundleId: z.string().optional(),
  iosAppStoreUrl: z.string().url().optional().or(z.literal('')),
  iosTeamId: z.string().optional(),
  iosAppStoreId: z.string().optional(),
  androidPackageName: z.string().optional(),
  androidPlayStoreUrl: z.string().url().optional().or(z.literal('')),
  androidSha256Fingerprints: z.string().optional(),
});

type ProjectForm = z.infer<typeof projectSchema>;

export default function ProjectSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { data: project, isLoading } = useProject(projectId);
  const updateProject = useUpdateProject(projectId!);
  const deleteProject = useDeleteProject(projectId!);
  const [showDelete, setShowDelete] = useState(false);
  const [showLeave, setShowLeave] = useState(false);
  const [billingTarget, setBillingTarget] = useState<string>('');
  const { user } = useAuth();
  const { data: membersResponse } = useProjectMembers(projectId);
  const offerBilling = useOfferBilling(projectId!);
  const cancelBillingOffer = useCancelBillingOffer(projectId!);
  const acceptBilling = useAcceptBilling(projectId!);
  const declineBilling = useDeclineBilling(projectId!);
  const leaveProject = useLeaveProject(projectId!);
  // Settings and the danger zone are the owners' (`project.admin`); everyone else reads.
  const administers = can(project, 'project.admin');
  const billingOffer = membersResponse?.billingOffer ?? null;
  const members = membersResponse?.members ?? [];
  const otherOwners = members.filter((m) => m.role === 'owner' && m.userId !== user?.id);
  const offeredTo = billingOffer ? members.find((m) => m.userId === billingOffer.toUserId) : undefined;
  const offerIsMine = !!billingOffer && billingOffer.toUserId === user?.id;

  /** The API's words, unless the person cancelled the sign-in prompt and knows why. */
  const failed = (title: string, err: unknown) => {
    if (reauthCancelled(err)) return;
    toast({ title, description: serverMessage(err) ?? undefined, variant: 'destructive' });
  };

  const handleOfferBilling = async () => {
    if (!billingTarget) return;
    try {
      await offerBilling.mutateAsync(billingTarget);
      setBillingTarget('');
      toast({ title: 'Billing offered', description: 'They have 7 days to accept.' });
    } catch (err) {
      failed('Billing not offered', err);
    }
  };

  const handleCancelOffer = async () => {
    try {
      await cancelBillingOffer.mutateAsync();
      toast({ title: 'Billing offer cancelled' });
    } catch (err) {
      failed('Offer not cancelled', err);
    }
  };

  const handleAcceptBilling = async () => {
    try {
      await acceptBilling.mutateAsync();
      toast({ title: 'This project is now billed to you' });
    } catch (err) {
      failed('Billing not moved', err);
    }
  };

  const handleDeclineBilling = async () => {
    try {
      await declineBilling.mutateAsync();
      toast({ title: 'Billing offer declined' });
    } catch (err) {
      failed('Offer not declined', err);
    }
  };

  const handleLeave = async () => {
    try {
      await leaveProject.mutateAsync();
      toast({ title: 'You left the project' });
      navigate('/projects', { replace: true });
    } catch (err) {
      failed('You are still in this project', err);
    }
    setShowLeave(false);
  };

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ProjectForm>({
    resolver: zodResolver(projectSchema),
  });

  useEffect(() => {
    if (project) {
      reset({
        name: project.name,
        domain: project.domain,
        webFallbackUrl: project.webFallbackUrl || '',
        iosBundleId: project.iosBundleId || '',
        iosAppStoreUrl: project.iosAppStoreUrl || '',
        iosTeamId: project.iosTeamId || '',
        iosAppStoreId: project.iosAppStoreId || '',
        androidPackageName: project.androidPackageName || '',
        androidPlayStoreUrl: project.androidPlayStoreUrl || '',
        androidSha256Fingerprints: project.androidSha256Fingerprints || '',
      });
    }
  }, [project, reset]);

  const onSubmit = async (data: ProjectForm) => {
    try {
      await updateProject.mutateAsync({
        name: data.name,
        domain: data.domain,
        webFallbackUrl: data.webFallbackUrl || null,
        iosBundleId: data.iosBundleId || null,
        iosAppStoreUrl: data.iosAppStoreUrl || null,
        iosTeamId: data.iosTeamId || null,
        iosAppStoreId: data.iosAppStoreId || null,
        androidPackageName: data.androidPackageName || null,
        androidPlayStoreUrl: data.androidPlayStoreUrl || null,
        androidSha256Fingerprints: data.androidSha256Fingerprints || null,
      });
      toast({ title: 'Project updated' });
    } catch {
      toast({ title: 'Error', description: 'Failed to update project', variant: 'destructive' });
    }
  };

  const handleDelete = async () => {
    try {
      await deleteProject.mutateAsync();
      toast({ title: 'Project deleted' });
      navigate('/');
    } catch (err) {
      failed('Project not deleted', err);
    }
    setShowDelete(false);
  };

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-3xl">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <Card>
          <CardContent className="p-6">
            <div className="h-60 animate-pulse rounded bg-muted" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Project not found</h1>
        <Button variant="outline" onClick={() => navigate('/')}>
          Back to projects
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-3xl font-bold">{project.name}</h1>
      </div>

      {!administers && (
        <p role="status" className="rounded-md border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          Only owners can change these settings.
        </p>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <fieldset disabled={!administers} className="space-y-6">
        {/* General */}
        <Card>
          <CardHeader>
            <CardTitle>General</CardTitle>
            <CardDescription>Basic project settings</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Project Name</Label>
                <Input {...register('name')} />
                {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
              </div>
              <div className="space-y-2">
                <Label>Domain</Label>
                <Input {...register('domain')} />
                {errors.domain && <p className="text-sm text-destructive">{errors.domain.message}</p>}
              </div>
            </div>
            <div className="space-y-2">
              <Label>Web Fallback URL</Label>
              <Input placeholder="https://example.com" {...register('webFallbackUrl')} />
              {errors.webFallbackUrl && (
                <p className="text-sm text-destructive">{errors.webFallbackUrl.message}</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* iOS Config */}
        <Card>
          <CardHeader>
            <CardTitle>iOS Configuration</CardTitle>
            <CardDescription>Configure iOS app settings for deep linking</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Bundle ID</Label>
                <Input placeholder="com.example.myapp" {...register('iosBundleId')} />
              </div>
              <div className="space-y-2">
                <Label>Team ID</Label>
                <Input placeholder="ABCDE12345" {...register('iosTeamId')} />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>App Store URL</Label>
                <Input placeholder="https://apps.apple.com/app/..." {...register('iosAppStoreUrl')} />
              </div>
              <div className="space-y-2">
                <Label>App Store ID</Label>
                <Input placeholder="123456789" {...register('iosAppStoreId')} />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Android Config */}
        <Card>
          <CardHeader>
            <CardTitle>Android Configuration</CardTitle>
            <CardDescription>Configure Android app settings for deep linking</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Package Name</Label>
                <Input placeholder="com.example.myapp" {...register('androidPackageName')} />
              </div>
              <div className="space-y-2">
                <Label>Play Store URL</Label>
                <Input
                  placeholder="https://play.google.com/store/apps/details?id=..."
                  {...register('androidPlayStoreUrl')}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>SHA-256 Fingerprints</Label>
              <Input
                placeholder="AA:BB:CC:DD:..."
                {...register('androidSha256Fingerprints')}
              />
              <p className="text-xs text-muted-foreground">
                Used for Android App Links verification (assetlinks.json)
              </p>
            </div>
          </CardContent>
        </Card>

        </fieldset>

        {/* Save */}
        {administers && (
          <div className="flex gap-3">
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        )}
      </form>

      <Separator />

      {offerIsMine && billingOffer && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wallet className="h-5 w-5" /> Take over billing
            </CardTitle>
            <CardDescription>
              You have been offered billing ownership of this project, until{' '}
              {format(new Date(billingOffer.expiresAt), 'MMM d, yyyy')}. It then counts towards your
              project limit and its members use your seats.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-3">
            <Button onClick={() => void handleAcceptBilling()} disabled={acceptBilling.isPending}>
              {acceptBilling.isPending ? 'Accepting...' : 'Accept billing'}
            </Button>
            <Button variant="outline" onClick={() => void handleDeclineBilling()} disabled={declineBilling.isPending}>
              Decline
            </Button>
          </CardContent>
        </Card>
      )}

      {administers && project.isBillingOwner && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wallet className="h-5 w-5" /> Billing owner
            </CardTitle>
            <CardDescription>
              This project is billed to you. You can hand billing to another owner; it moves once they accept.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {billingOffer ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm">
                  Offered to {offeredTo?.name || offeredTo?.email || 'another owner'}, until{' '}
                  {format(new Date(billingOffer.expiresAt), 'MMM d, yyyy')}.
                </p>
                <Button variant="outline" onClick={() => void handleCancelOffer()} disabled={cancelBillingOffer.isPending}>
                  Cancel offer
                </Button>
              </div>
            ) : otherOwners.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Billing can only move to another owner. Make someone an owner on the Members page first.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Select value={billingTarget} onValueChange={setBillingTarget}>
                  <SelectTrigger className="w-64" aria-label="Owner to offer billing to">
                    <SelectValue placeholder="Choose an owner" />
                  </SelectTrigger>
                  <SelectContent>
                    {otherOwners.map((owner) => (
                      <SelectItem key={owner.userId} value={owner.userId}>
                        {owner.name || owner.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button onClick={() => void handleOfferBilling()} disabled={!billingTarget || offerBilling.isPending}>
                  {offerBilling.isPending ? 'Offering...' : 'Offer billing'}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LogOut className="h-5 w-5" /> Leave project
          </CardTitle>
          <CardDescription>
            {project.isBillingOwner
              ? 'This project is billed to you, so you cannot leave it. Move billing to another owner first.'
              : 'You lose access to this project. Pending invites you sent are cancelled.'}
          </CardDescription>
        </CardHeader>
        {!project.isBillingOwner && (
          <CardContent>
            <Button variant="outline" onClick={() => setShowLeave(true)}>
              Leave project
            </Button>
          </CardContent>
        )}
      </Card>

      {administers && (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="text-destructive">Danger Zone</CardTitle>
            <CardDescription>
              Deleting a project will also delete all its links and analytics data.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="destructive" type="button" onClick={() => setShowDelete(true)}>
              <Trash2 className="mr-2 h-4 w-4" /> Delete Project
            </Button>
          </CardContent>
        </Card>
      )}

      <Dialog open={showLeave} onOpenChange={setShowLeave}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Leave {project.name}?</DialogTitle>
            <DialogDescription>
              You lose access at once. To come back, someone has to invite you again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowLeave(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleLeave()} disabled={leaveProject.isPending}>
              {leaveProject.isPending ? 'Leaving...' : 'Leave project'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDelete} onOpenChange={setShowDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Project</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &quot;{project.name}&quot;? This will permanently
              delete all links and analytics data. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteProject.isPending}>
              {deleteProject.isPending ? 'Deleting...' : 'Delete Project'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
