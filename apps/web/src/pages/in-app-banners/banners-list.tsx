import { useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, Trash2, Image, Grid3X3, Play, Layers, GalleryHorizontal, Copy, ChevronDown, Pencil, Eye, MousePointer, TrendingUp, Users } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { SelectRoot as Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  useBannerCategories,
  useCreateBannerCategory,
  useDeleteBannerCategory,
  useInAppBanners,
  useWidgetAnalyticsSummary,
  useWidgetAnalyticsTimeseries,
  type BannerCategory,
} from '@/hooks/use-inline-banners';
import { apiPost } from '@/lib/api';
import { toast } from '@/components/ui/use-toast';
import { cn } from '@/lib/utils';
import { useQueryClient } from '@tanstack/react-query';

const WIDGET_TYPES: Record<string, { layout: string; backendLayout: string; label: string; icon: typeof Image; description: string; itemLabel: string }> = {
  banners: {
    layout: 'single',
    backendLayout: 'single',
    label: 'Banners',
    icon: Image,
    description: 'Full-width or section-width promotional images with CTA',
    itemLabel: 'banner',
  },
  carousels: {
    layout: 'carousel',
    backendLayout: 'carousel',
    label: 'Carousels',
    icon: Layers,
    description: 'Auto-rotating horizontal slider of multiple items',
    itemLabel: 'slide',
  },
  stories: {
    layout: 'single',
    backendLayout: 'stories',
    label: 'Stories',
    icon: Play,
    description: 'Sequential full-screen cards like Instagram stories',
    itemLabel: 'story',
  },
  grids: {
    layout: 'grid',
    backendLayout: 'grid',
    label: 'Grids',
    icon: Grid3X3,
    description: 'Multi-item grid layout for product tiles and recommendations',
    itemLabel: 'tile',
  },
  'swipe-strips': {
    layout: 'swipe_strip',
    backendLayout: 'swipe_strip',
    label: 'Swipe Strips',
    icon: GalleryHorizontal,
    description: 'Horizontal scrollable strip of cards',
    itemLabel: 'card',
  },
};

const ASPECT_RATIOS = [
  { label: '16:9', value: '16:9' },
  { label: '4:3', value: '4:3' },
  { label: '1:1', value: '1:1' },
  { label: '3:2', value: '3:2' },
  { label: '21:9', value: '21:9' },
  { label: '9:16', value: '9:16' },
];

interface CreateForm {
  name: string;
  description: string;
  aspectRatio: string;
  autoRotate: boolean;
  rotationInterval: string;
  heading: string;
  backgroundColor: string;
  padding: string;
  config: Record<string, any>;
  // Banner-level fields (single layout only)
  imageUrl: string;
  clickUrl: string;
  ctaText: string;
  startsAt: Date | undefined;
  expiresAt: Date | undefined;
}

const defaultForm: CreateForm = {
  name: '',
  description: '',
  aspectRatio: '16:9',
  autoRotate: true,
  rotationInterval: '5',
  heading: '',
  backgroundColor: '#ffffff',
  padding: '0',
  config: {},
  imageUrl: '',
  clickUrl: '',
  ctaText: '',
  startsAt: undefined,
  expiresAt: undefined,
};

export default function BannerCategoriesListPage() {
  const { projectId, type } = useParams<{ projectId: string; type: string }>();
  const navigate = useNavigate();
  const widgetType = WIDGET_TYPES[type || ''];
  const { data: allCategories, isLoading } = useBannerCategories(projectId);
  const createCategory = useCreateBannerCategory(projectId!);
  const deleteCategory = useDeleteBannerCategory(projectId!);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<CreateForm>(defaultForm);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (!widgetType) {
    return <div className="p-8 text-center text-muted-foreground">Unknown widget type.</div>;
  }

  const categories = allCategories?.filter((c) => c.layout === widgetType.backendLayout) ?? [];
  const isSingleLayout = widgetType.layout === 'single';

  const queryClient = useQueryClient();

  const handleCreate = async () => {
    if (!form.name) return;
    if (isSingleLayout && (!form.imageUrl || !form.clickUrl)) {
      toast({ title: 'Image URL and Click URL are required', variant: 'destructive' });
      return;
    }
    if (isSingleLayout && form.startsAt && form.expiresAt && form.startsAt >= form.expiresAt) {
      toast({ title: 'End date must be after start date', variant: 'destructive' });
      return;
    }
    try {
      const category = await createCategory.mutateAsync({
        name: form.name,
        description: form.description || undefined,
        layout: widgetType.backendLayout,
        aspectRatio: form.aspectRatio,
        autoRotate: form.autoRotate,
        rotationInterval: parseInt(form.rotationInterval, 10) || 5,
        heading: form.heading || undefined,
        backgroundColor: form.backgroundColor,
        padding: parseInt(form.padding, 10) || 0,
        config: Object.keys(form.config).length > 0 ? form.config : undefined,
      } as any);
      if (isSingleLayout && category?.id) {
        await apiPost(`/api/banner-categories/${category.id}/banners`, {
          title: form.name,
          imageUrl: form.imageUrl,
          clickUrl: form.clickUrl,
          ctaText: form.ctaText || undefined,
          startsAt: form.startsAt?.toISOString() || undefined,
          expiresAt: form.expiresAt?.toISOString() || undefined,
          sortOrder: 0,
        });
        queryClient.invalidateQueries({ queryKey: ['in-app-banners', category.id] });
      }
      setShowCreate(false);
      setForm(defaultForm);
      toast({ title: `${widgetType.label.slice(0, -1)} created` });
    } catch {
      toast({ title: 'Failed to create', variant: 'destructive' });
    }
  };

  const updateConfig = (key: string, value: any) => {
    setForm({ ...form, config: { ...form.config, [key]: value } });
  };

  const handleRowClick = (category: BannerCategory) => {
    setExpandedId(expandedId === category.id ? null : category.id);
  };

  const statusBadge = (status: string) => (
    <Badge variant={status === 'active' ? 'default' : 'outline'} className={
      status === 'draft' ? 'bg-yellow-100 text-yellow-800 border-yellow-300' :
      status === 'paused' ? 'bg-gray-100 text-gray-600 border-gray-300' : ''
    }>
      {status === 'draft' ? 'Draft' : status === 'active' ? 'Active' : 'Paused'}
    </Badge>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">{widgetType.label}</h1>
          <p className="text-muted-foreground mt-1">{widgetType.description}</p>
        </div>
        <Button onClick={() => navigate(`/projects/${projectId}/widgets/${type}/new`)}>
          <Plus className="mr-2 h-4 w-4" /> New {widgetType.label.slice(0, -1)}
        </Button>
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="p-6">
            <div className="h-20 animate-pulse rounded bg-muted" />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow className="[&_th]:text-xs">
                <TableHead className="w-[280px]">{widgetType.label.slice(0, -1)}</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>{isSingleLayout ? 'Aspect Ratio' : 'Items'}</TableHead>
                <TableHead>Last Updated</TableHead>
                <TableHead className="text-right">Impressions</TableHead>
                <TableHead className="text-right">Clicks</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {categories.map((category) => (
                <ExpandableBannerRow
                  key={category.id}
                  category={category}
                  isExpanded={expandedId === category.id}
                  onToggle={() => handleRowClick(category)}
                  onDelete={() => {
                    if (confirm(`Delete this ${widgetType.itemLabel} and all its data?`)) {
                      deleteCategory.mutate(category.id);
                      if (expandedId === category.id) setExpandedId(null);
                    }
                  }}
                  onEdit={() => isSingleLayout
                    ? navigate(`/projects/${projectId}/widgets/${type}/${category.id}/edit`)
                    : navigate(`/projects/${projectId}/widgets/${type}/${category.id}`)
                  }
                  statusBadge={statusBadge}
                  isSingleLayout={isSingleLayout}
                  itemLabel={widgetType.itemLabel}
                />
              ))}
              {categories.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                    No {widgetType.label.toLowerCase()} yet. Create one to get started.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isSingleLayout ? 'Create Banner' : `Create ${widgetType.label.slice(0, -1)} Widget`}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name *</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={isSingleLayout ? 'e.g. Summer Sale Banner' : `e.g. Homepage ${widgetType.label.slice(0, -1)}`}
              />
            </div>

            <>
                <div className="space-y-2">
                  <Label>Description</Label>
                  <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Optional description" />
                </div>
                <div className="space-y-2">
                  <Label>Aspect Ratio</Label>
                  <Select value={form.aspectRatio} onValueChange={(v: string) => setForm({ ...form, aspectRatio: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ASPECT_RATIOS.map((r) => (
                        <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Heading</Label>
                  <Input value={form.heading} onChange={(e) => setForm({ ...form, heading: e.target.value })} placeholder="Optional heading above widget" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Background Color</Label>
                    <div className="flex gap-2">
                      <Input type="color" value={form.backgroundColor} onChange={(e) => setForm({ ...form, backgroundColor: e.target.value })} className="w-12 h-9 p-1" />
                      <Input value={form.backgroundColor} onChange={(e) => setForm({ ...form, backgroundColor: e.target.value })} />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Padding (px)</Label>
                    <Input type="number" value={form.padding} onChange={(e) => setForm({ ...form, padding: e.target.value })} />
                  </div>
                </div>

                {widgetType.layout === 'carousel' && (
                  <div className="space-y-3 rounded-lg border p-3">
                    <p className="text-sm font-medium">Carousel Settings</p>
                    <div className="flex items-center justify-between">
                      <Label>Auto Rotate</Label>
                      <Switch checked={form.autoRotate} onCheckedChange={(checked) => setForm({ ...form, autoRotate: checked })} />
                    </div>
                    {form.autoRotate && (
                      <div className="space-y-2">
                        <Label>Rotation Interval (seconds)</Label>
                        <Input type="number" value={form.rotationInterval} onChange={(e) => setForm({ ...form, rotationInterval: e.target.value })} />
                      </div>
                    )}
                    <div className="flex items-center justify-between"><Label>Show Dots</Label><Switch checked={form.config.showDots ?? true} onCheckedChange={(checked) => updateConfig('showDots', checked)} /></div>
                    <div className="flex items-center justify-between"><Label>Show Arrows</Label><Switch checked={form.config.showArrows ?? true} onCheckedChange={(checked) => updateConfig('showArrows', checked)} /></div>
                    <div className="flex items-center justify-between"><Label>Infinite Loop</Label><Switch checked={form.config.infinite ?? true} onCheckedChange={(checked) => updateConfig('infinite', checked)} /></div>
                  </div>
                )}

                {widgetType.layout === 'grid' && (
                  <div className="space-y-3 rounded-lg border p-3">
                    <p className="text-sm font-medium">Grid Settings</p>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2"><Label>Columns</Label><Input type="number" value={form.config.columns ?? 2} onChange={(e) => updateConfig('columns', parseInt(e.target.value, 10) || 2)} /></div>
                      <div className="space-y-2"><Label>Gap (px)</Label><Input type="number" value={form.config.gap ?? 8} onChange={(e) => updateConfig('gap', parseInt(e.target.value, 10) || 8)} /></div>
                    </div>
                  </div>
                )}

                {widgetType.layout === 'stories' && (
                  <div className="space-y-3 rounded-lg border p-3">
                    <p className="text-sm font-medium">Stories Settings</p>
                    <div className="flex items-center justify-between"><Label>Auto Advance</Label><Switch checked={form.config.autoAdvance ?? true} onCheckedChange={(checked) => updateConfig('autoAdvance', checked)} /></div>
                    <div className="space-y-2"><Label>Advance Interval (seconds)</Label><Input type="number" value={form.config.advanceInterval ?? 5} onChange={(e) => updateConfig('advanceInterval', parseInt(e.target.value, 10) || 5)} /></div>
                    <div className="flex items-center justify-between"><Label>Show Progress Bar</Label><Switch checked={form.config.showProgressBar ?? true} onCheckedChange={(checked) => updateConfig('showProgressBar', checked)} /></div>
                  </div>
                )}

                {widgetType.layout === 'swipe_strip' && (
                  <div className="space-y-3 rounded-lg border p-3">
                    <p className="text-sm font-medium">Swipe Strip Settings</p>
                    <div className="flex items-center justify-between"><Label>Auto Rotate</Label><Switch checked={form.autoRotate} onCheckedChange={(checked) => setForm({ ...form, autoRotate: checked })} /></div>
                    {form.autoRotate && (
                      <div className="space-y-2"><Label>Rotation Interval (seconds)</Label><Input type="number" value={form.rotationInterval} onChange={(e) => setForm({ ...form, rotationInterval: e.target.value })} /></div>
                    )}
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2"><Label>Item Width (px)</Label><Input type="number" value={form.config.itemWidth ?? 120} onChange={(e) => updateConfig('itemWidth', parseInt(e.target.value, 10) || 120)} /></div>
                      <div className="space-y-2"><Label>Gap (px)</Label><Input type="number" value={form.config.gap ?? 8} onChange={(e) => updateConfig('gap', parseInt(e.target.value, 10) || 8)} /></div>
                    </div>
                    <div className="flex items-center justify-between"><Label>Snap to Item</Label><Switch checked={form.config.snapToItem ?? true} onCheckedChange={(checked) => updateConfig('snapToItem', checked)} /></div>
                  </div>
                )}
              </>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={createCategory.isPending}>
              {createCategory.isPending ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}

/* === Expandable Banner Row === */

const RANGES = [
  { label: '7d', days: 7, granularity: 'day' },
  { label: '30d', days: 30, granularity: 'day' },
  { label: '90d', days: 90, granularity: 'week' },
  { label: 'All time', days: 0, granularity: 'month' },
];

function ExpandableBannerRow({
  category,
  isExpanded,
  onToggle,
  onDelete,
  onEdit,
  statusBadge,
  isSingleLayout = true,
  itemLabel = 'banner',
}: {
  category: BannerCategory;
  isExpanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onEdit: () => void;
  statusBadge: (status: string) => React.ReactNode;
  isSingleLayout?: boolean;
  itemLabel?: string;
}) {
  const [rangeIdx, setRangeIdx] = useState(1);
  const range = RANGES[rangeIdx];

  const { start, end } = useMemo(() => {
    return {
      start: range.days > 0 ? new Date(Date.now() - range.days * 86400000).toISOString() : undefined,
      end: range.days > 0 ? new Date().toISOString() : undefined,
    };
  }, [range.days]);

  const { data: bannerItems } = useInAppBanners(category.id);
  const thumbnailUrl = bannerItems?.[0]?.imageUrl;

  const { data: summary } = useWidgetAnalyticsSummary(isExpanded ? category.id : undefined);
  const { data: timeseries } = useWidgetAnalyticsTimeseries(
    isExpanded ? category.id : undefined,
    start,
    end,
    range.granularity,
  );

  const totalImpressions = category.totalImpressions ?? summary?.totalImpressions ?? 0;
  const totalClicks = category.totalClicks ?? summary?.totalClicks ?? 0;
  const ctr = summary?.ctr ? (summary.ctr * 100).toFixed(1) : '0';

  const copyWidgetId = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(category.id);
    toast({ title: 'Widget ID copied' });
  };

  return (
    <>
      <TableRow
        className="cursor-pointer hover:bg-muted/50"
        onClick={onToggle}
      >
        <TableCell>
          <div className="flex items-center gap-3">
            <div className="h-10 w-16 rounded bg-muted flex items-center justify-center overflow-hidden shrink-0">
              {thumbnailUrl ? (
                <img src={thumbnailUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <Image className="h-4 w-4 text-muted-foreground" />
              )}
            </div>
            <div className="min-w-0">
              <p className="font-medium truncate">{category.name}</p>
              {category.description && (
                <p className="text-xs text-muted-foreground truncate max-w-[200px]">{category.description}</p>
              )}
            </div>
          </div>
        </TableCell>
        <TableCell>{statusBadge(category.status)}</TableCell>
        <TableCell className="text-sm text-muted-foreground">
          {isSingleLayout
            ? (category.aspectRatio || '—')
            : `${category.bannerCount ?? 0} ${itemLabel}${(category.bannerCount ?? 0) !== 1 ? 's' : ''}`
          }
        </TableCell>
        <TableCell className="text-sm text-muted-foreground">
          {new Date(category.updatedAt).toLocaleDateString()}
        </TableCell>
        <TableCell className="text-right font-medium">{totalImpressions.toLocaleString()}</TableCell>
        <TableCell className="text-right font-medium">{totalClicks.toLocaleString()}</TableCell>
        <TableCell>
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', isExpanded && 'rotate-180')} />
        </TableCell>
      </TableRow>

      {isExpanded && (
        <TableRow>
          <TableCell colSpan={7} className="bg-muted/30 p-0">
            <div className="p-6 space-y-6">
              {/* Stat Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="flex items-center justify-between gap-3 rounded-lg border bg-background p-3">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">Impressions</p>
                    <p className="text-xl font-bold">{totalImpressions.toLocaleString()}</p>
                  </div>
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Eye className="h-4 w-4" />
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-lg border bg-background p-3">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">Clicks</p>
                    <p className="text-xl font-bold">{totalClicks.toLocaleString()}</p>
                  </div>
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <MousePointer className="h-4 w-4" />
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-lg border bg-background p-3">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">CTR</p>
                    <p className="text-xl font-bold">{ctr}%</p>
                  </div>
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <TrendingUp className="h-4 w-4" />
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-lg border bg-background p-3">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">Unique Visitors</p>
                    <p className="text-xl font-bold">{(summary?.uniqueVisitors ?? 0).toLocaleString()}</p>
                  </div>
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Users className="h-4 w-4" />
                  </div>
                </div>
              </div>

              {/* Interval selector + Chart */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">Performance</p>
                  <div className="flex items-center gap-1">
                    {RANGES.map((r, i) => (
                      <Button
                        key={r.label}
                        variant={rangeIdx === i ? 'default' : 'ghost'}
                        size="sm"
                        className="h-7 px-2.5 text-xs"
                        onClick={() => setRangeIdx(i)}
                      >
                        {r.label}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="h-52 rounded-lg border bg-background p-3">
                  {timeseries && timeseries.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={timeseries}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                        <XAxis
                          dataKey="date"
                          tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                          tickFormatter={(d) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        />
                        <YAxis tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: 'var(--card)',
                            border: '1px solid var(--border)',
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                          labelFormatter={(d) => new Date(d).toLocaleDateString()}
                        />
                        <Bar dataKey="impressions" fill="var(--chart-4)" fillOpacity={0.75} radius={[4, 4, 0, 0]} name="Impressions" />
                        <Bar dataKey="clicks" fill="var(--chart-1)" fillOpacity={1} radius={[4, 4, 0, 0]} name="Clicks" />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                      No data available for this period
                    </div>
                  )}
                </div>
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between border-t pt-4">
                <p className="text-xs text-muted-foreground italic">
                  Widget ID: {category.id}
                </p>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={copyWidgetId}>
                    <Copy className="h-4 w-4 mr-1" /> Copy ID
                  </Button>
                  <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); onEdit(); }}>
                    <Pencil className="h-4 w-4 mr-1" /> Edit
                  </Button>
                  <Button variant="destructive" size="sm" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
                    <Trash2 className="h-4 w-4 mr-1" /> Delete
                  </Button>
                </div>
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
