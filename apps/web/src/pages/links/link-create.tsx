import { useNavigate, useParams } from 'react-router-dom';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useCreateLink } from '@/hooks/use-links';
import { toast } from '@/components/ui/use-toast';

const linkSchema = z.object({
  longUrl: z.string().url('Must be a valid URL'),
  shortCode: z
    .string()
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      'Only letters, numbers, hyphens, and underscores are allowed',
    )
    .min(3, 'Must be at least 3 characters')
    .max(30, 'Must be at most 30 characters')
    .optional()
    .or(z.literal('')),
  title: z.string().optional(),
  tags: z.string().optional(),
  isActive: z.boolean().default(true),
  expiresAt: z.string().optional(),
  iosUrl: z.string().url().optional().or(z.literal('')),
  androidUrl: z.string().url().optional().or(z.literal('')),
  iosFallbackUrl: z.string().url().optional().or(z.literal('')),
  androidFallbackUrl: z.string().url().optional().or(z.literal('')),
  ogTitle: z.string().optional(),
  ogDescription: z.string().optional(),
  ogImageUrl: z.string().url().optional().or(z.literal('')),
  deepLinkParams: z.string().optional(),
});

type LinkForm = z.infer<typeof linkSchema>;

export default function LinkCreatePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
    watch,
  } = useForm<LinkForm>({
    resolver: zodResolver(linkSchema),
    defaultValues: {
      isActive: true,
      longUrl: '',
      shortCode: '',
      title: '',
      tags: '',
      expiresAt: '',
      iosUrl: '',
      androidUrl: '',
      iosFallbackUrl: '',
      androidFallbackUrl: '',
      ogTitle: '',
      ogDescription: '',
      ogImageUrl: '',
      deepLinkParams: '',
    },
  });

  const createLink = useCreateLink(projectId!);
  const watchedOgTitle = watch('ogTitle');
  const watchedOgDescription = watch('ogDescription');
  const watchedOgImageUrl = watch('ogImageUrl');
  const watchedTitle = watch('title');
  const watchedLongUrl = watch('longUrl');

  const previewTitle = watchedOgTitle || watchedTitle || 'Preview title';
  const previewDescription = watchedOgDescription || 'Preview description will appear here.';
  const previewImageUrl = watchedOgImageUrl || '';
  const previewDomain = (() => {
    if (!watchedLongUrl) return 'your-short-link.domain';
    try {
      return new URL(watchedLongUrl).host;
    } catch {
      return watchedLongUrl;
    }
  })();

  const onSubmit = async (data: LinkForm) => {
    let parsedParams: Record<string, unknown> | null = null;
    if (data.deepLinkParams) {
      try {
        parsedParams = JSON.parse(data.deepLinkParams);
      } catch {
        toast({ title: 'Invalid JSON', description: 'Deep link params must be valid JSON', variant: 'destructive' });
        return;
      }
    }

    try {
      const link = await createLink.mutateAsync({
        longUrl: data.longUrl,
        shortCode: data.shortCode ? data.shortCode.trim() : undefined,
        title: data.title || undefined,
        tags: data.tags ? data.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        isActive: data.isActive,
        expiresAt: data.expiresAt || null,
        iosUrl: data.iosUrl || null,
        androidUrl: data.androidUrl || null,
        iosFallbackUrl: data.iosFallbackUrl || null,
        androidFallbackUrl: data.androidFallbackUrl || null,
        ogTitle: data.ogTitle || null,
        ogDescription: data.ogDescription || null,
        ogImageUrl: data.ogImageUrl || null,
        deepLinkParams: parsedParams,
      });
      toast({ title: 'Link created', description: `Short code: ${link.shortCode}` });
      navigate(`/projects/${projectId}/links/${link.id}`);
    } catch (err: unknown) {
      const message =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { message?: string } } }).response?.data?.message
          : undefined;
      toast({ title: 'Error', description: message || 'Failed to create link', variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-6 w-full ">
      <h1 className="text-3xl font-bold">Create Link</h1>

      <form onSubmit={handleSubmit(onSubmit)}>
        <Tabs defaultValue="basic">
          <TabsList>
            <TabsTrigger value="basic">Basic</TabsTrigger>
            <TabsTrigger value="deeplink">Deep Linking</TabsTrigger>
            <TabsTrigger value="social">Social Preview</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="basic">
            <Card>
              <CardHeader>
                <CardTitle>Basic Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="longUrl">Destination URL</Label>
                  <Input id="longUrl" placeholder="https://example.com/page" {...register('longUrl')} />
                  {errors.longUrl && (
                    <p className="text-sm text-destructive">{errors.longUrl.message}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="shortCode">
                    Custom short link <span className="text-muted-foreground font-normal">(optional)</span>
                  </Label>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground whitespace-nowrap">
                      {window.location.host}/
                    </span>
                    <Input
                      id="shortCode"
                      placeholder="my-launch-campaign"
                      {...register('shortCode')}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    3–30 characters. Letters, numbers, hyphens, and underscores only.
                    Leave blank to auto-generate. Cannot be changed after creation.
                  </p>
                  {errors.shortCode && (
                    <p className="text-sm text-destructive">{errors.shortCode.message}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="title">Title</Label>
                  <Input id="title" placeholder="My awesome link" {...register('title')} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tags">Tags (comma-separated)</Label>
                  <Input id="tags" placeholder="marketing, summer-campaign" {...register('tags')} />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="deeplink">
            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>Deep Linking</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label>iOS Deep Link URL</Label>
                      <Input placeholder="myapp://path" {...register('iosUrl')} />
                      {errors.iosUrl && <p className="text-sm text-destructive">{errors.iosUrl.message}</p>}
                    </div>
                    <div className="space-y-2">
                      <Label>Android Deep Link URL</Label>
                      <Input placeholder="myapp://path" {...register('androidUrl')} />
                      {errors.androidUrl && <p className="text-sm text-destructive">{errors.androidUrl.message}</p>}
                    </div>
                    <div className="space-y-2">
                      <Label>iOS Fallback URL</Label>
                      <Input placeholder="https://apps.apple.com/..." {...register('iosFallbackUrl')} />
                    </div>
                    <div className="space-y-2">
                      <Label>Android Fallback URL</Label>
                      <Input placeholder="https://play.google.com/..." {...register('androidFallbackUrl')} />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Deep Link Parameters (JSON)</Label>
                    <Textarea
                      placeholder='{"screen": "product", "id": "123"}'
                      rows={4}
                      className="font-mono text-sm"
                      {...register('deepLinkParams')}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card className="h-fit">
                <CardHeader>
                  <CardTitle>Deep Link Flow</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="rounded-lg border bg-muted/20 p-4">
                    <svg
                      viewBox="0 0 900 420"
                      className="h-auto w-full"
                      role="img"
                      aria-label="Deep link flow graph"
                    >
                      <defs>
                        <marker
                          id="arrow"
                          viewBox="0 0 10 10"
                          refX="9"
                          refY="5"
                          markerWidth="8"
                          markerHeight="8"
                          orient="auto-start-reverse"
                        >
                          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                        </marker>
                      </defs>

                      <rect x="310" y="20" width="280" height="44" rx="8" className="fill-background stroke-muted-foreground" />
                      <text x="450" y="48" textAnchor="middle" className="fill-foreground text-[14px] font-semibold">
                        Your Dynamic Link
                      </text>

                      <rect x="70" y="110" width="220" height="34" rx="6" className="fill-emerald-500/20 stroke-emerald-500" />
                      <text x="180" y="132" textAnchor="middle" className="fill-emerald-700 text-[13px] font-semibold">
                        Android
                      </text>

                      <rect x="340" y="110" width="220" height="34" rx="6" className="fill-sky-500/20 stroke-sky-500" />
                      <text x="450" y="132" textAnchor="middle" className="fill-sky-700 text-[13px] font-semibold">
                        iOS
                      </text>

                      <rect x="610" y="110" width="220" height="34" rx="6" className="fill-fuchsia-500/20 stroke-fuchsia-500" />
                      <text x="720" y="132" textAnchor="middle" className="fill-fuchsia-700 text-[13px] font-semibold">
                        Desktop
                      </text>

                      <line x1="450" y1="64" x2="180" y2="110" stroke="currentColor" strokeWidth="2" markerEnd="url(#arrow)" />
                      <line x1="450" y1="64" x2="450" y2="110" stroke="currentColor" strokeWidth="2" markerEnd="url(#arrow)" />
                      <line x1="450" y1="64" x2="720" y2="110" stroke="currentColor" strokeWidth="2" markerEnd="url(#arrow)" />

                      <text x="120" y="190" textAnchor="middle" className="fill-muted-foreground text-[11px]">Click</text>
                      <line x1="180" y1="144" x2="180" y2="220" stroke="currentColor" strokeWidth="2" markerEnd="url(#arrow)" />

                      <rect x="80" y="230" width="200" height="30" rx="15" className="fill-emerald-500/10 stroke-emerald-500" />
                      <text x="180" y="250" textAnchor="middle" className="fill-emerald-700 text-[12px] font-semibold">
                        App Installed?
                      </text>

                      <text x="110" y="300" textAnchor="middle" className="fill-muted-foreground text-[11px]">Yes</text>
                      <line x1="140" y1="260" x2="140" y2="320" stroke="currentColor" strokeWidth="2" markerEnd="url(#arrow)" />
                      <rect x="80" y="330" width="120" height="40" rx="6" className="fill-background stroke-muted-foreground" />
                      <text x="140" y="355" textAnchor="middle" className="fill-foreground text-[11px]">App with deep link</text>

                      <text x="250" y="300" textAnchor="middle" className="fill-muted-foreground text-[11px]">No</text>
                      <line x1="220" y1="260" x2="220" y2="320" stroke="currentColor" strokeWidth="2" markerEnd="url(#arrow)" />
                      <rect x="200" y="330" width="120" height="40" rx="6" className="fill-background stroke-muted-foreground" />
                      <text x="260" y="355" textAnchor="middle" className="fill-foreground text-[11px]">Play Store</text>

                      <text x="450" y="190" textAnchor="middle" className="fill-muted-foreground text-[11px]">Type into browser</text>
                      <line x1="450" y1="144" x2="450" y2="220" stroke="currentColor" strokeWidth="2" markerEnd="url(#arrow)" />
                      <rect x="390" y="230" width="120" height="40" rx="6" className="fill-background stroke-muted-foreground" />
                      <text x="450" y="255" textAnchor="middle" className="fill-foreground text-[11px]">Web link</text>

                      <text x="720" y="190" textAnchor="middle" className="fill-muted-foreground text-[11px]">Type into browser</text>
                      <line x1="720" y1="144" x2="720" y2="220" stroke="currentColor" strokeWidth="2" markerEnd="url(#arrow)" />
                      <rect x="660" y="230" width="120" height="40" rx="6" className="fill-background stroke-muted-foreground" />
                      <text x="720" y="255" textAnchor="middle" className="fill-foreground text-[11px]">Web link</text>
                    </svg>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="social">
            <div className="grid gap-6 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>Social Preview</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label>OG Title</Label>
                    <Input placeholder="Preview title" {...register('ogTitle')} />
                  </div>
                  <div className="space-y-2">
                    <Label>OG Description</Label>
                    <Textarea placeholder="Preview description" rows={3} {...register('ogDescription')} />
                  </div>
                  <div className="space-y-2">
                    <Label>OG Image URL</Label>
                    <Input placeholder="https://example.com/image.png" {...register('ogImageUrl')} />
                    {errors.ogImageUrl && (
                      <p className="text-sm text-destructive">{errors.ogImageUrl.message}</p>
                    )}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Live Preview</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="rounded-lg border bg-background overflow-hidden">
                    <div className="aspect-[16/9] bg-muted flex items-center justify-center">
                      {previewImageUrl ? (
                        <img
                          src={previewImageUrl}
                          alt="Social preview"
                          className="h-full w-full object-cover"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      ) : (
                        <span className="text-sm text-muted-foreground">Image preview</span>
                      )}
                    </div>
                    <div className="p-4 space-y-2">
                      <div className="text-sm text-muted-foreground">{previewDomain}</div>
                      <div className="font-semibold">{previewTitle}</div>
                      <div className="text-sm text-muted-foreground line-clamp-2">
                        {previewDescription}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="settings">
            <Card>
              <CardHeader>
                <CardTitle>Settings</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Active</Label>
                    <p className="text-sm text-muted-foreground">Enable or disable this link</p>
                  </div>
                  <Controller
                    name="isActive"
                    control={control}
                    render={({ field }) => (
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    )}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Expiration Date</Label>
                  <Input type="datetime-local" {...register('expiresAt')} />
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <div className="flex gap-3 mt-6">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Creating...' : 'Create Link'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate(`/projects/${projectId}/links`)}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
