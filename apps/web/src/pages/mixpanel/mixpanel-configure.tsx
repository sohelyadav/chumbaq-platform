import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useMixpanelStatus, useConfigureMixpanel } from '@/hooks/use-mixpanel-cohorts';
import { toast } from '@/components/ui/use-toast';
import { useCurrentProject } from '@/contexts/project-context';
import { can, shownValue } from '@/lib/project-role';

interface ConfigureForm {
  serviceAccountUsername: string;
  serviceAccountPassword: string;
  mixpanelProjectId: string;
}

export default function MixpanelConfigurePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { data: status, isLoading: statusLoading } = useMixpanelStatus(projectId);
  const configureMixpanel = useConfigureMixpanel(projectId!);
  const [showPassword, setShowPassword] = useState(false);
  const { project } = useCurrentProject();
  // Connecting Mixpanel is `channels.manage`; everyone else sees the status only.
  const manages = can(project, 'channels.manage');

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ConfigureForm>();

  const onSubmit = async (data: ConfigureForm) => {
    try {
      await configureMixpanel.mutateAsync(data);
      toast({ title: 'Mixpanel configured successfully' });
    } catch {
      toast({ title: 'Error', description: 'Failed to configure Mixpanel', variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(`/projects/${projectId}/mixpanel/cohorts`)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-3xl font-bold">Mixpanel Integration</h1>
      </div>

      {!statusLoading && status && (
        <Card>
          <CardHeader>
            <CardTitle>Current Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">Status:</span>
              <Badge variant={status.configured ? 'default' : 'secondary'}>
                {status.configured ? 'Configured' : 'Not Configured'}
              </Badge>
              {status.isActive && (
                <Badge variant="default" className="bg-green-500">Active</Badge>
              )}
            </div>
            {status.configured && (
              <div className="grid grid-cols-[150px_1fr] gap-1 text-sm pt-2">
                <span className="text-muted-foreground">Project ID:</span>
                <span className="font-medium">{status.mixpanelProjectId || 'N/A'}</span>
                
                <span className="text-muted-foreground">Service Account:</span>
                <span className="font-medium">{shownValue(status.serviceAccountUsername, project) || 'N/A'}</span>
              </div>
            )}
            {status.lastTestAt && (
              <p className="text-sm text-muted-foreground">
                Last tested: {new Date(status.lastTestAt).toLocaleString()}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {!manages && (
        <p role="status" className="rounded-md border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          Only owners and admins can connect Mixpanel.
        </p>
      )}

      {manages && (
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Service Account Credentials</CardTitle>
            <CardDescription>
              Enter your Mixpanel service account credentials to enable cohort syncing.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Service Account Username</Label>
              <Input
                placeholder="service-account@mixpanel.com"
                {...register('serviceAccountUsername', { required: 'Username is required' })}
              />
              {errors.serviceAccountUsername && (
                <p className="text-sm text-destructive">{errors.serviceAccountUsername.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Service Account Password</Label>
              <div className="relative">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Service account secret"
                  {...register('serviceAccountPassword', { required: 'Password is required' })}
                />
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
              {errors.serviceAccountPassword && (
                <p className="text-sm text-destructive">{errors.serviceAccountPassword.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Mixpanel Project ID</Label>
              <Input
                placeholder="123456"
                {...register('mixpanelProjectId', { required: 'Project ID is required' })}
              />
              {errors.mixpanelProjectId && (
                <p className="text-sm text-destructive">{errors.mixpanelProjectId.message}</p>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="flex gap-3">
          <Button type="submit" disabled={isSubmitting || configureMixpanel.isPending}>
            {isSubmitting || configureMixpanel.isPending ? 'Saving...' : 'Save Configuration'}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate(`/projects/${projectId}/mixpanel/cohorts`)}
          >
            View Cohorts
          </Button>
        </div>
      </form>
      )}
    </div>
  );
}
