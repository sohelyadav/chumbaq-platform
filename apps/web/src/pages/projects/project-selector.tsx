import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Globe, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useProjects, useCreateProject } from '@/hooks/use-projects';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from '@/components/ui/use-toast';
import { canCreateProject, projectCountLabel } from '@/lib/project-limit';
import { roleLabel } from '@/lib/project-role';
import { Badge } from '@/components/ui/badge';

/** The server's own words, which say what the limit is and what to do. */
function serverMessage(err: unknown): string | null {
  const message = (err as { response?: { data?: { message?: unknown } } } | null)?.response?.data?.message;
  return typeof message === 'string' && message ? message : null;
}

const createProjectSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  domain: z.string().min(1, 'Domain is required'),
});

type CreateProjectForm = z.infer<typeof createProjectSchema>;

export default function ProjectSelectorPage() {
  const navigate = useNavigate();
  const { data: projectsResponse, isLoading, error } = useProjects();
  const projects = projectsResponse?.data;
  const createProject = useCreateProject();
  const [showCreate, setShowCreate] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // The limit counts projects billed to this account, not every project they belong to.
  const billed = projectsResponse?.meta.billedProjects ?? 0;
  const projectLimit = projectsResponse?.meta.projectLimit;
  const canCreate = canCreateProject(billed, projectLimit);
  const atLimitMessage =
    projectLimit === undefined
      ? null
      : `You can have up to ${projectLimit} projects. Delete one or contact support to raise the limit.`;

  const openCreate = () => {
    setCreateError(null);
    setShowCreate(true);
  };

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateProjectForm>({
    resolver: zodResolver(createProjectSchema),
  });

  const onSubmit = async (data: CreateProjectForm) => {
    try {
      const project = await createProject.mutateAsync(data);
      toast({ title: 'Project created', description: project.name });
      setShowCreate(false);
      reset();
      navigate(`/projects/${project.id}/settings`);
    } catch (err) {
      // The limit may have been reached in another tab since the list loaded.
      const message = serverMessage(err) ?? 'Failed to create project';
      setCreateError(message);
      toast({ title: 'Project not created', description: message, variant: 'destructive' });
    }
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">Your Projects</h1>
          <p className="text-muted-foreground mt-1">Every project you belong to, with your role in it.</p>
          {projectLimit !== undefined && (
            <p className="text-sm text-muted-foreground mt-1">{projectCountLabel(billed, projectLimit)}</p>
          )}
        </div>
        <Button onClick={openCreate} disabled={!canCreate}>
          <Plus className="mr-2 h-4 w-4" /> New Project
        </Button>
      </div>
      {!canCreate && atLimitMessage && (
        <p role="status" className="mb-6 rounded-md border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          {atLimitMessage}
        </p>
      )}

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[...Array(3)].map((_, i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <div className="h-24 animate-pulse rounded bg-muted" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="p-6 text-center text-destructive">
            Failed to load projects.
          </CardContent>
        </Card>
      ) : !projects || projects.length === 0 ? (
        <Card className="max-w-md mx-auto">
          <CardContent className="p-12 text-center">
            <div className="flex aspect-square size-16 items-center justify-center rounded-2xl bg-primary/10 text-primary mx-auto mb-4">
              <Plus className="size-8" />
            </div>
            <h2 className="text-xl font-semibold mb-2">No projects yet</h2>
            <p className="text-muted-foreground mb-6">Create your first project to start managing dynamic links.</p>
            <Button onClick={openCreate} size="lg" disabled={!canCreate}>
              <Plus className="mr-2 h-4 w-4" /> Create Project
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Card
              key={project.id}
              className="cursor-pointer hover:border-primary/50 transition-colors group"
              onClick={() => navigate(`/projects/${project.id}`)}
            >
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">{project.name}</CardTitle>
                  <div className="flex items-center gap-2">
                    {project.role && (
                      <Badge variant={project.role === 'member' ? 'outline' : 'secondary'}>{roleLabel(project.role)}</Badge>
                    )}
                    <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                </div>
                <CardDescription className="flex items-center gap-1">
                  <Globe className="h-3 w-3" />
                  {project.domain}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  {project.linkCount !== undefined && (
                    <span>{project.linkCount} link{project.linkCount !== 1 ? 's' : ''}</span>
                  )}
                  {project.iosBundleId && <span>iOS</span>}
                  {project.androidPackageName && <span>Android</span>}
                </div>
              </CardContent>
            </Card>
          ))}

          {/* Create new project card, left out once the account is at its limit */}
          {canCreate && (
            <Card
              className="cursor-pointer border-dashed hover:border-primary/50 transition-colors"
              onClick={openCreate}
            >
              <CardContent className="p-6 flex flex-col items-center justify-center h-full min-h-[120px] text-muted-foreground">
                <Plus className="h-8 w-8 mb-2" />
                <span className="text-sm font-medium">New Project</span>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Project</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit(onSubmit)}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Project Name</Label>
                <Input placeholder="My App" {...register('name')} />
                {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
              </div>
              <div className="space-y-2">
                <Label>Domain</Label>
                <Input placeholder="example.com" {...register('domain')} />
                {errors.domain && <p className="text-sm text-destructive">{errors.domain.message}</p>}
              </div>
              {createError && (
                <p role="alert" className="text-sm text-destructive">
                  {createError}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Creating...' : 'Create Project'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
