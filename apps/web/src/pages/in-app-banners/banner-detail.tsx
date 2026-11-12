import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, GripVertical, ChevronUp, ChevronDown, Eye, MousePointer, Image, Copy, Pencil, BarChart3, Type } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { SelectRoot as Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import {
  useBannerCategoryDetail,
  useUpdateBannerCategory,
  useUpdateBannerCategoryStatus,
  useInAppBanners,
  useCreateInAppBanner,
  useUpdateInAppBanner,
  useDeleteInAppBanner,
  useReorderBanners,
  type InAppBanner,
} from '@/hooks/use-inline-banners';
import { toast } from '@/components/ui/use-toast';
import { cn } from '@/lib/utils';

const ASPECT_RATIOS = [
  { label: '16:9', value: '16:9' },
  { label: '4:3', value: '4:3' },
  { label: '1:1', value: '1:1' },
  { label: '3:2', value: '3:2' },
  { label: '21:9', value: '21:9' },
  { label: '9:16', value: '9:16' },
];

interface BannerFormState {
  title: string;
  imageUrl: string;
  clickUrl: string;
  ctaText: string;
  startsAt: Date | undefined;
  expiresAt: Date | undefined;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmContent: string;
  utmTerm: string;
  storyType: 'image' | 'text';
  storyText: string;
  storyBgColor: string;
  storyTextColor: string;
  duration: string;
}

const defaultBannerForm: BannerFormState = {
  title: '',
  imageUrl: '',
  clickUrl: '',
  ctaText: '',
  startsAt: undefined,
  expiresAt: undefined,
  utmSource: '',
  utmMedium: '',
  utmCampaign: '',
  utmContent: '',
  utmTerm: '',
  storyType: 'image',
  storyText: '',
  storyBgColor: '#6366f1',
  storyTextColor: '#ffffff',
  duration: '',
};

export default function BannerCategoryDetailPage() {
  const { projectId, type, categoryId } = useParams<{ projectId: string; type: string; categoryId: string }>();
  const navigate = useNavigate();
  const { data: category, isLoading: categoryLoading } = useBannerCategoryDetail(categoryId);
  const { data: banners, isLoading: bannersLoading } = useInAppBanners(categoryId);
  const updateCategory = useUpdateBannerCategory(categoryId!);
  const updateStatus = useUpdateBannerCategoryStatus(categoryId!);
  const createBanner = useCreateInAppBanner(categoryId!);
  const updateBanner = useUpdateInAppBanner(categoryId!);
  const deleteBanner = useDeleteInAppBanner(categoryId!);
  const reorderBanners = useReorderBanners(categoryId!);

  const [showAddBanner, setShowAddBanner] = useState(false);
  const [showEditBanner, setShowEditBanner] = useState(false);
  const [editingBanner, setEditingBanner] = useState<InAppBanner | null>(null);
  const [bannerForm, setBannerForm] = useState(defaultBannerForm);
  const [showEditSettings, setShowEditSettings] = useState(false);
  const [settingsForm, setSettingsForm] = useState<Record<string, any>>({});
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);

  const isStoriesLayout = category?.layout === 'stories';

  const validateDates = (form: BannerFormState): boolean => {
    if (form.startsAt && form.expiresAt && form.startsAt >= form.expiresAt) {
      toast({ title: 'End date must be after start date', variant: 'destructive' });
      return false;
    }
    return true;
  };

  const handleAddBanner = async () => {
    if (isStoriesLayout) {
      if (bannerForm.storyType === 'image' && !bannerForm.imageUrl) return;
      if (bannerForm.storyType === 'text' && (!bannerForm.storyText || !bannerForm.storyBgColor)) return;
      if (bannerForm.ctaText && !bannerForm.clickUrl) return;
    } else {
      if (!bannerForm.title || !bannerForm.clickUrl || !bannerForm.imageUrl) return;
    }
    if (!validateDates(bannerForm)) return;
    try {
      const meta: Record<string, any> = {};
      if (bannerForm.utmSource) meta.utm_source = bannerForm.utmSource;
      if (bannerForm.utmMedium) meta.utm_medium = bannerForm.utmMedium;
      if (bannerForm.utmCampaign) meta.utm_campaign = bannerForm.utmCampaign;
      if (bannerForm.utmContent) meta.utm_content = bannerForm.utmContent;
      if (bannerForm.utmTerm) meta.utm_term = bannerForm.utmTerm;
      if (isStoriesLayout) {
        meta.storyType = bannerForm.storyType;
        if (bannerForm.storyType === 'text') {
          meta.storyText = bannerForm.storyText;
          meta.backgroundColor = bannerForm.storyBgColor;
          meta.textColor = bannerForm.storyTextColor;
        }
        if (bannerForm.duration) meta.duration = parseInt(bannerForm.duration, 10);
      }
      const storyTitle = isStoriesLayout
        ? bannerForm.storyType === 'text'
          ? bannerForm.storyText.slice(0, 50)
          : bannerForm.title || 'Image Story'
        : bannerForm.title;
      await createBanner.mutateAsync({
        title: storyTitle,
        imageUrl: isStoriesLayout && bannerForm.storyType === 'text' ? undefined : bannerForm.imageUrl,
        clickUrl: bannerForm.clickUrl || undefined,
        ctaText: bannerForm.ctaText || undefined,
        startsAt: bannerForm.startsAt?.toISOString() || undefined,
        expiresAt: bannerForm.expiresAt?.toISOString() || undefined,
        sortOrder: (banners?.length ?? 0),
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
      } as any);
      setShowAddBanner(false);
      setBannerForm(defaultBannerForm);
      toast({ title: isStoriesLayout ? 'Story added' : 'Banner added' });
    } catch {
      toast({ title: 'Failed to add banner', variant: 'destructive' });
    }
  };

  const handleEditBanner = async () => {
    if (!editingBanner) return;
    if (isStoriesLayout) {
      if (bannerForm.storyType === 'image' && !bannerForm.imageUrl) return;
      if (bannerForm.storyType === 'text' && (!bannerForm.storyText || !bannerForm.storyBgColor)) return;
      if (bannerForm.ctaText && !bannerForm.clickUrl) return;
    } else {
      if (!bannerForm.title || !bannerForm.imageUrl || !bannerForm.clickUrl) return;
    }
    if (!validateDates(bannerForm)) return;
    try {
      const meta: Record<string, any> = {};
      if (bannerForm.utmSource) meta.utm_source = bannerForm.utmSource;
      if (bannerForm.utmMedium) meta.utm_medium = bannerForm.utmMedium;
      if (bannerForm.utmCampaign) meta.utm_campaign = bannerForm.utmCampaign;
      if (bannerForm.utmContent) meta.utm_content = bannerForm.utmContent;
      if (bannerForm.utmTerm) meta.utm_term = bannerForm.utmTerm;
      if (isStoriesLayout) {
        meta.storyType = bannerForm.storyType;
        if (bannerForm.storyType === 'text') {
          meta.storyText = bannerForm.storyText;
          meta.backgroundColor = bannerForm.storyBgColor;
          meta.textColor = bannerForm.storyTextColor;
        }
        if (bannerForm.duration) meta.duration = parseInt(bannerForm.duration, 10);
      }
      const storyTitle = isStoriesLayout
        ? bannerForm.storyType === 'text'
          ? bannerForm.storyText.slice(0, 50)
          : bannerForm.title || 'Image Story'
        : bannerForm.title;
      await updateBanner.mutateAsync({
        id: editingBanner.id,
        title: storyTitle,
        imageUrl: isStoriesLayout && bannerForm.storyType === 'text' ? undefined : bannerForm.imageUrl,
        clickUrl: bannerForm.clickUrl || undefined,
        ctaText: bannerForm.ctaText || undefined,
        startsAt: bannerForm.startsAt?.toISOString() || undefined,
        expiresAt: bannerForm.expiresAt?.toISOString() || undefined,
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
      } as any);
      setShowEditBanner(false);
      setEditingBanner(null);
      setBannerForm(defaultBannerForm);
      toast({ title: isStoriesLayout ? 'Story updated' : 'Banner updated' });
    } catch {
      toast({ title: 'Failed to update banner', variant: 'destructive' });
    }
  };

  const openEditBanner = (banner: InAppBanner) => {
    setEditingBanner(banner);
    const bannerMeta = (banner as any).metadata;
    setBannerForm({
      title: banner.title,
      imageUrl: banner.imageUrl || '',
      clickUrl: banner.clickUrl || '',
      ctaText: banner.ctaText || '',
      startsAt: banner.startsAt ? new Date(banner.startsAt) : undefined,
      expiresAt: banner.expiresAt ? new Date(banner.expiresAt) : undefined,
      utmSource: bannerMeta?.utm_source || '',
      utmMedium: bannerMeta?.utm_medium || '',
      utmCampaign: bannerMeta?.utm_campaign || '',
      utmContent: bannerMeta?.utm_content || '',
      utmTerm: bannerMeta?.utm_term || '',
      storyType: bannerMeta?.storyType || 'image',
      storyText: bannerMeta?.storyText || '',
      storyBgColor: bannerMeta?.backgroundColor || '#6366f1',
      storyTextColor: bannerMeta?.textColor || '#ffffff',
      duration: bannerMeta?.duration ? String(bannerMeta.duration) : '',
    });
    setShowEditBanner(true);
  };

  const handleMove = (index: number, direction: 'up' | 'down') => {
    if (!banners) return;
    const sorted = [...banners].sort((a, b) => a.sortOrder - b.sortOrder);
    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= sorted.length) return;
    const items = sorted.map((b, i) => ({
      id: b.id,
      sortOrder: i === index ? sorted[swapIndex].sortOrder : i === swapIndex ? sorted[index].sortOrder : b.sortOrder,
    }));
    reorderBanners.mutate(items);
  };

  const handleDragReorder = (fromIndex: number, toIndex: number) => {
    const sorted = [...(banners || [])].sort((a, b) => a.sortOrder - b.sortOrder);
    const items = sorted.map((b, i) => {
      let newIndex = i;
      if (i === fromIndex) newIndex = toIndex;
      else if (fromIndex < toIndex && i > fromIndex && i <= toIndex) newIndex = i - 1;
      else if (fromIndex > toIndex && i >= toIndex && i < fromIndex) newIndex = i + 1;
      return { id: b.id, sortOrder: newIndex };
    });
    reorderBanners.mutate(items);
  };

  const handleSaveSettings = async () => {
    try {
      await updateCategory.mutateAsync(settingsForm as any);
      setShowEditSettings(false);
      toast({ title: 'Settings updated' });
    } catch {
      toast({ title: 'Failed to update settings', variant: 'destructive' });
    }
  };

  const copyWidgetId = () => {
    if (categoryId) {
      navigator.clipboard.writeText(categoryId);
      toast({ title: 'Widget ID copied' });
    }
  };

  const isLoading = categoryLoading || bannersLoading;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="h-40 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  if (!category) {
    return <div className="p-8 text-center text-muted-foreground">Category not found.</div>;
  }

  const sortedBanners = [...(banners || [])].sort((a, b) => a.sortOrder - b.sortOrder);
  const isSingleLayout = category.layout === 'single';
  const singleBanner = isSingleLayout ? sortedBanners[0] : null;

  const getScheduleStatus = (banner: InAppBanner) => {
    const now = new Date();
    if (banner.expiresAt && new Date(banner.expiresAt) < now) return 'expired';
    if (banner.startsAt && new Date(banner.startsAt) > now) return 'scheduled';
    return 'live';
  };

  const openSettings = () => {
    setSettingsForm({
      name: category.name,
      description: category.description || '',
      aspectRatio: category.aspectRatio || '16:9',
      autoRotate: category.autoRotate,
      rotationInterval: category.rotationInterval,
      heading: category.heading || '',
      backgroundColor: category.backgroundColor,
      padding: category.padding,
      config: category.config || {},
    });
    setShowEditSettings(true);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/projects/${projectId}/widgets/${type}`)}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">{category.name}</h1>
            <Badge variant={category.status === 'active' ? 'default' : 'outline'} className={
              category.status === 'draft' ? 'bg-yellow-100 text-yellow-800 border-yellow-300' :
              category.status === 'paused' ? 'bg-gray-100 text-gray-600 border-gray-300' : ''
            }>
              {category.status === 'draft' ? 'Draft' : category.status === 'active' ? 'Active' : 'Paused'}
            </Badge>
          </div>
          {category.description && <p className="text-muted-foreground mt-1">{category.description}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={copyWidgetId}>
            <Copy className="h-4 w-4 mr-1" /> Copy ID
          </Button>
          <Button variant="outline" size="sm" onClick={openSettings}>
            <Pencil className="h-4 w-4 mr-1" /> Settings
          </Button>
          <Select value={category.status} onValueChange={(v: string) => updateStatus.mutate(v, { onError: () => toast({ title: 'Failed to update status', variant: 'destructive' }) })}>
            <SelectTrigger className="w-32" disabled={updateStatus.isPending}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isSingleLayout ? (
        /* === Single Banner Layout (no tabs, no multi-item) === */
        <div className="space-y-4">
          {singleBanner ? (
            <SingleBannerView
              banner={singleBanner}
              onEdit={() => openEditBanner(singleBanner)}
              onDelete={() => deleteBanner.mutate(singleBanner.id)}
              onToggleActive={(checked) => updateBanner.mutate({ id: singleBanner.id, isActive: checked })}
              getScheduleStatus={getScheduleStatus}
            />
          ) : (
            <Card>
              <CardContent className="p-8 text-center space-y-4">
                <Image className="h-12 w-12 mx-auto text-muted-foreground" />
                <p className="text-muted-foreground">No banner set yet.</p>
                <Button onClick={() => { setBannerForm(defaultBannerForm); setShowAddBanner(true); }}>
                  <Plus className="mr-2 h-4 w-4" /> Set Banner
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      ) : (
        /* === Multi-item Layout (carousel, grid, stories, swipe_strip) === */
        <Tabs defaultValue="items">
          <TabsList>
            <TabsTrigger value="items">Items ({sortedBanners.length})</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="items" className="space-y-4 mt-4">
            <div className="flex items-center justify-end">
              <Button onClick={() => { setBannerForm(defaultBannerForm); setShowAddBanner(true); }}>
                <Plus className="mr-2 h-4 w-4" /> Add Item
              </Button>
            </div>
            <div className="space-y-3">
              {sortedBanners.map((banner, index) => {
                const scheduleStatus = getScheduleStatus(banner);
                const isExpanded = expandedItemId === banner.id;
                const ctr = banner.impressions > 0 ? ((banner.clicks / banner.impressions) * 100).toFixed(1) : '0.0';
                return (
                  <div key={banner.id} className="space-y-0">
                    <Card
                      draggable
                      onDragStart={() => setDragIndex(index)}
                      onDragOver={(e) => { e.preventDefault(); }}
                      onDrop={() => { if (dragIndex !== null && dragIndex !== index) handleDragReorder(dragIndex, index); setDragIndex(null); }}
                      onDragEnd={() => setDragIndex(null)}
                      className={cn('transition-opacity', dragIndex === index && 'opacity-50')}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-center gap-4">
                          <div className="flex flex-col items-center gap-0.5">
                            <Button variant="ghost" size="sm" className="h-5 w-5 p-0" disabled={index === 0} onClick={() => handleMove(index, 'up')} aria-label="Move up">
                              <ChevronUp className="h-3.5 w-3.5" />
                            </Button>
                            <div className="cursor-grab active:cursor-grabbing">
                              <GripVertical className="h-4 w-4 text-muted-foreground" />
                            </div>
                            <Button variant="ghost" size="sm" className="h-5 w-5 p-0" disabled={index === sortedBanners.length - 1} onClick={() => handleMove(index, 'down')} aria-label="Move down">
                              <ChevronDown className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                          <div className="h-16 w-24 rounded bg-muted flex items-center justify-center overflow-hidden shrink-0">
                            {isStoriesLayout && (banner as any).metadata?.storyType === 'text' ? (
                              <div
                                className="h-full w-full flex items-center justify-center p-1"
                                style={{ backgroundColor: (banner as any).metadata?.backgroundColor || '#6366f1' }}
                              >
                                <Type className="h-5 w-5" style={{ color: (banner as any).metadata?.textColor || '#ffffff' }} />
                              </div>
                            ) : banner.imageUrl ? (
                              <img src={banner.imageUrl} alt="" className="h-full w-full object-cover" />
                            ) : (
                              <Image className="h-6 w-6 text-muted-foreground" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="font-medium truncate">{banner.title}</p>
                              {isStoriesLayout && (
                                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                  {(banner as any).metadata?.storyType === 'text' ? 'Text' : 'Image'}
                                </Badge>
                              )}
                              {scheduleStatus === 'scheduled' && <Badge variant="outline" className="bg-blue-50 text-blue-700 text-xs">Scheduled</Badge>}
                              {scheduleStatus === 'expired' && <Badge variant="outline" className="bg-red-50 text-red-700 text-xs">Expired</Badge>}
                            </div>
                            <p className="text-sm text-muted-foreground truncate">{banner.clickUrl}</p>
                            {(banner.startsAt || banner.expiresAt) && (
                              <p className="text-xs text-muted-foreground mt-1">
                                {banner.startsAt && `From: ${new Date(banner.startsAt).toLocaleDateString()}`}
                                {banner.startsAt && banner.expiresAt && ' · '}
                                {banner.expiresAt && `Until: ${new Date(banner.expiresAt).toLocaleDateString()}`}
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-4 text-sm text-muted-foreground shrink-0">
                            <div className="flex items-center gap-1" title="Impressions"><Eye className="h-4 w-4" /><span>{banner.impressions}</span></div>
                            <div className="flex items-center gap-1" title="Clicks"><MousePointer className="h-4 w-4" /><span>{banner.clicks}</span></div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Button variant="ghost" size="sm" onClick={() => setExpandedItemId(isExpanded ? null : banner.id)} title="Toggle analytics">
                              <BarChart3 className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => openEditBanner(banner)}><Pencil className="h-4 w-4" /></Button>
                            <Switch checked={banner.isActive} onCheckedChange={(checked) => updateBanner.mutate({ id: banner.id, isActive: checked })} />
                            <Button variant="ghost" size="sm" onClick={() => { if (confirm('Delete this item? This cannot be undone.')) deleteBanner.mutate(banner.id); }}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                    {isExpanded && (
                      <div className="mx-4 rounded-b-lg border border-t-0 bg-muted/30 px-4 py-3">
                        <div className="flex items-center gap-6 text-sm">
                          <div className="flex items-center gap-2">
                            <Eye className="h-4 w-4 text-muted-foreground" />
                            <span className="font-medium">{banner.impressions}</span>
                            <span className="text-muted-foreground">impressions</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <MousePointer className="h-4 w-4 text-muted-foreground" />
                            <span className="font-medium">{banner.clicks}</span>
                            <span className="text-muted-foreground">clicks</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{ctr}%</span>
                            <span className="text-muted-foreground">CTR</span>
                          </div>
                          <div className="ml-auto">
                            <Button
                              variant="link"
                              size="sm"
                              className="h-auto p-0 text-sm"
                              onClick={() => navigate(`/projects/${projectId}/widgets/${type}/${categoryId}/items/${banner.id}/report`)}
                            >
                              View full report &rarr;
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {sortedBanners.length === 0 && (
                <Card><CardContent className="p-8 text-center text-muted-foreground">No items yet. Add one to get started.</CardContent></Card>
              )}
            </div>
          </TabsContent>

          <TabsContent value="settings" className="mt-4">
            <SettingsDisplay category={category} onEdit={openSettings} />
          </TabsContent>
        </Tabs>
      )}

      {/* Add Banner Dialog */}
      <BannerFormDialog open={showAddBanner} onOpenChange={setShowAddBanner} title={isSingleLayout ? 'Set Banner' : 'Add Item'} form={bannerForm} setForm={setBannerForm} onSubmit={handleAddBanner} isPending={createBanner.isPending} submitLabel={isSingleLayout ? 'Save' : 'Add'} isStories={isStoriesLayout} />

      {/* Edit Banner Dialog */}
      <BannerFormDialog open={showEditBanner} onOpenChange={(open) => { setShowEditBanner(open); if (!open) setEditingBanner(null); }} title="Edit Banner" form={bannerForm} setForm={setBannerForm} onSubmit={handleEditBanner} isPending={updateBanner.isPending} submitLabel="Save" isStories={isStoriesLayout} />

      {/* Edit Settings Dialog */}
      <Dialog open={showEditSettings} onOpenChange={setShowEditSettings}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Edit Widget Settings</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={settingsForm.name || ''} onChange={(e) => setSettingsForm({ ...settingsForm, name: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Input value={settingsForm.description || ''} onChange={(e) => setSettingsForm({ ...settingsForm, description: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Aspect Ratio</Label>
              <Select value={settingsForm.aspectRatio || '16:9'} onValueChange={(v: string) => setSettingsForm({ ...settingsForm, aspectRatio: v })}>
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
              <Input value={settingsForm.heading || ''} onChange={(e) => setSettingsForm({ ...settingsForm, heading: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Background Color</Label>
                <div className="flex gap-2">
                  <Input type="color" value={settingsForm.backgroundColor || '#ffffff'} onChange={(e) => setSettingsForm({ ...settingsForm, backgroundColor: e.target.value })} className="w-12 h-9 p-1" />
                  <Input value={settingsForm.backgroundColor || '#ffffff'} onChange={(e) => setSettingsForm({ ...settingsForm, backgroundColor: e.target.value })} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Padding (px)</Label>
                <Input type="number" value={settingsForm.padding ?? 0} onChange={(e) => setSettingsForm({ ...settingsForm, padding: parseInt(e.target.value, 10) || 0 })} />
              </div>
            </div>
            {!isSingleLayout && (
              <>
                <div className="flex items-center justify-between">
                  <Label>Auto Rotate</Label>
                  <Switch checked={settingsForm.autoRotate ?? true} onCheckedChange={(checked) => setSettingsForm({ ...settingsForm, autoRotate: checked })} />
                </div>
                {settingsForm.autoRotate && (
                  <div className="space-y-2">
                    <Label>Rotation Interval (seconds)</Label>
                    <Input type="number" value={settingsForm.rotationInterval ?? 5} onChange={(e) => setSettingsForm({ ...settingsForm, rotationInterval: parseInt(e.target.value, 10) || 5 })} />
                  </div>
                )}
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditSettings(false)}>Cancel</Button>
            <Button onClick={handleSaveSettings} disabled={updateCategory.isPending}>
              {updateCategory.isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* === Single Banner View === */
function SingleBannerView({
  banner,
  onEdit,
  onDelete,
  onToggleActive,
  getScheduleStatus,
}: {
  banner: InAppBanner;
  onEdit: () => void;
  onDelete: () => void;
  onToggleActive: (checked: boolean) => void;
  getScheduleStatus: (b: InAppBanner) => string;
}) {
  const scheduleStatus = getScheduleStatus(banner);

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex gap-6">
          {/* Image preview */}
          <div className="h-32 w-48 rounded-lg bg-muted flex items-center justify-center overflow-hidden shrink-0">
            {banner.imageUrl ? (
              <img src={banner.imageUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <Image className="h-8 w-8 text-muted-foreground" />
            )}
          </div>

          {/* Details */}
          <div className="flex-1 min-w-0 space-y-2">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold">{banner.title}</h3>
              {scheduleStatus === 'scheduled' && <Badge variant="outline" className="bg-blue-50 text-blue-700 text-xs">Scheduled</Badge>}
              {scheduleStatus === 'expired' && <Badge variant="outline" className="bg-red-50 text-red-700 text-xs">Expired</Badge>}
              {scheduleStatus === 'live' && banner.isActive && <Badge className="text-xs">Live</Badge>}
            </div>
            <p className="text-sm text-muted-foreground truncate">{banner.clickUrl}</p>
            {banner.ctaText && <p className="text-sm">CTA: {banner.ctaText}</p>}
            {(banner.startsAt || banner.expiresAt) && (
              <p className="text-xs text-muted-foreground">
                {banner.startsAt && `From: ${new Date(banner.startsAt).toLocaleString()}`}
                {banner.startsAt && banner.expiresAt && ' · '}
                {banner.expiresAt && `Until: ${new Date(banner.expiresAt).toLocaleString()}`}
              </p>
            )}
            <div className="flex items-center gap-4 text-sm text-muted-foreground pt-1">
              <div className="flex items-center gap-1"><Eye className="h-4 w-4" /><span>{banner.impressions} impressions</span></div>
              <div className="flex items-center gap-1"><MousePointer className="h-4 w-4" /><span>{banner.clicks} clicks</span></div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-col items-end gap-2 shrink-0">
            <div className="flex items-center gap-2">
              <Switch checked={banner.isActive} onCheckedChange={onToggleActive} />
              <Button variant="outline" size="sm" onClick={onEdit}><Pencil className="h-4 w-4 mr-1" /> Edit</Button>
              <Button variant="destructive" size="sm" onClick={onDelete}><Trash2 className="h-4 w-4 mr-1" /> Delete</Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* === Settings Display === */
function SettingsDisplay({ category, onEdit }: { category: any; onEdit: () => void }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-lg">Widget Configuration</CardTitle>
        <Button variant="outline" size="sm" onClick={onEdit}><Pencil className="h-4 w-4 mr-1" /> Edit</Button>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div><span className="text-muted-foreground">Layout</span><p className="font-medium capitalize">{category.layout.replace('_', ' ')}</p></div>
          <div><span className="text-muted-foreground">Aspect Ratio</span><p className="font-medium">{category.aspectRatio || 'Auto'}</p></div>
          <div><span className="text-muted-foreground">Auto Rotate</span><p className="font-medium">{category.autoRotate ? `Yes (${category.rotationInterval}s)` : 'No'}</p></div>
          <div>
            <span className="text-muted-foreground">Background</span>
            <div className="flex items-center gap-2">
              <div className="h-4 w-4 rounded border" style={{ backgroundColor: category.backgroundColor }} />
              <span className="font-medium">{category.backgroundColor}</span>
            </div>
          </div>
          {category.heading && <div className="col-span-2"><span className="text-muted-foreground">Heading</span><p className="font-medium">{category.heading}</p></div>}
          <div><span className="text-muted-foreground">Padding</span><p className="font-medium">{category.padding}px</p></div>
        </div>
      </CardContent>
    </Card>
  );
}

/* === Reusable Banner Form Dialog === */
function BannerFormDialog({
  open, onOpenChange, title, form, setForm, onSubmit, isPending, submitLabel, isStories = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  form: BannerFormState;
  setForm: (form: BannerFormState) => void;
  onSubmit: () => void;
  isPending: boolean;
  submitLabel: string;
  isStories?: boolean;
}) {
  const [imgError, setImgError] = useState(false);

  const isValid = isStories
    ? form.storyType === 'image'
      ? !!form.imageUrl && (!form.ctaText || !!form.clickUrl)
      : !!form.storyText && !!form.storyBgColor && (!form.ctaText || !!form.clickUrl)
    : !!(form.title && form.imageUrl && form.clickUrl);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('max-h-[90vh] overflow-y-auto', isStories ? 'max-w-4xl' : 'max-w-2xl')}>
        <DialogHeader>
          <DialogTitle className="text-lg">{isStories ? (form.storyType === 'text' ? 'Text Story' : 'Image Story') : title}</DialogTitle>
        </DialogHeader>

        <div className={cn(isStories ? 'flex gap-6' : '')}>
          {/* Form side */}
          <div className={cn('space-y-5 py-2', isStories ? 'flex-1 min-w-0' : '')}>

            {/* Story type toggle */}
            {isStories && (
              <div className="flex rounded-lg bg-muted p-1 w-fit">
                <button
                  type="button"
                  onClick={() => setForm({ ...form, storyType: 'image' })}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-4 py-1.5 text-sm font-medium transition-all',
                    form.storyType === 'image' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Image className="h-3.5 w-3.5" /> Image
                </button>
                <button
                  type="button"
                  onClick={() => setForm({ ...form, storyType: 'text' })}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-4 py-1.5 text-sm font-medium transition-all',
                    form.storyType === 'text' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Type className="h-3.5 w-3.5" /> Text
                </button>
              </div>
            )}

            {isStories ? (
              /* === Story-specific fields === */
              <div className="space-y-4">
                {form.storyType === 'image' ? (
                  <>
                    <div className="space-y-2">
                      <Label className="text-sm font-medium">Image URL <span className="text-destructive">*</span></Label>
                      <Input
                        value={form.imageUrl}
                        onChange={(e) => { setForm({ ...form, imageUrl: e.target.value }); setImgError(false); }}
                        placeholder="https://example.com/story.jpg"
                      />
                      {imgError && <p className="text-xs text-destructive">Failed to load image</p>}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label className="text-sm font-medium">Story Text <span className="text-destructive">*</span></Label>
                      <Textarea
                        value={form.storyText}
                        onChange={(e) => setForm({ ...form, storyText: e.target.value })}
                        placeholder="What's your story?"
                        rows={3}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label className="text-xs text-muted-foreground">Background Color</Label>
                        <div className="flex gap-2">
                          <Input type="color" value={form.storyBgColor} onChange={(e) => setForm({ ...form, storyBgColor: e.target.value })} className="w-10 h-9 p-1 cursor-pointer" />
                          <Input value={form.storyBgColor} onChange={(e) => setForm({ ...form, storyBgColor: e.target.value })} className="flex-1" />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs text-muted-foreground">Text Color</Label>
                        <div className="flex gap-2">
                          <Input type="color" value={form.storyTextColor} onChange={(e) => setForm({ ...form, storyTextColor: e.target.value })} className="w-10 h-9 p-1 cursor-pointer" />
                          <Input value={form.storyTextColor} onChange={(e) => setForm({ ...form, storyTextColor: e.target.value })} className="flex-1" />
                        </div>
                      </div>
                    </div>
                  </>
                )}

                <div className="space-y-2">
                  <Label className="text-sm font-medium">CTA Text <span className="font-normal text-muted-foreground">(optional)</span></Label>
                  <Input
                    value={form.ctaText}
                    onChange={(e) => setForm({ ...form, ctaText: e.target.value })}
                    placeholder="e.g. Shop Now"
                  />
                </div>
                {form.ctaText && (
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">Click URL <span className="text-destructive">*</span></Label>
                    <Input
                      value={form.clickUrl}
                      onChange={(e) => setForm({ ...form, clickUrl: e.target.value })}
                      placeholder="https://example.com/offer"
                    />
                  </div>
                )}
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Duration <span className="font-normal text-muted-foreground">(seconds, optional)</span></Label>
                  <Input
                    type="number"
                    min="1"
                    value={form.duration}
                    onChange={(e) => setForm({ ...form, duration: e.target.value })}
                    placeholder="Default"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">Start Date</Label>
                    <DateTimePicker value={form.startsAt} onChange={(date) => setForm({ ...form, startsAt: date })} placeholder="Select start" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">End Date</Label>
                    <DateTimePicker value={form.expiresAt} onChange={(date) => setForm({ ...form, expiresAt: date })} placeholder="Select end" />
                  </div>
                </div>
              </div>
            ) : (
              /* === Standard banner fields === */
              <>
                <div className="rounded-xl border-2 border-dashed border-muted-foreground/20 bg-muted/30 overflow-hidden">
                  {form.imageUrl && !imgError ? (
                    <img src={form.imageUrl} alt="Preview" className="h-40 w-full object-contain bg-muted/50" onError={() => setImgError(true)} />
                  ) : (
                    <div className="h-32 flex flex-col items-center justify-center gap-2">
                      <Image className="h-8 w-8 text-muted-foreground/40" />
                      <p className="text-sm text-muted-foreground/60">{form.imageUrl ? 'Failed to load image' : 'Image preview will appear here'}</p>
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2 md:col-span-2">
                    <Label className="text-sm font-medium">Title <span className="text-destructive">*</span></Label>
                    <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Summer Sale Banner" />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label className="text-sm font-medium">Image URL <span className="text-destructive">*</span></Label>
                    <Input value={form.imageUrl} onChange={(e) => { setForm({ ...form, imageUrl: e.target.value }); setImgError(false); }} placeholder="https://example.com/banner.jpg" />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label className="text-sm font-medium">Click URL <span className="text-destructive">*</span></Label>
                    <Input value={form.clickUrl} onChange={(e) => setForm({ ...form, clickUrl: e.target.value })} placeholder="https://example.com/offer" />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label className="text-sm font-medium">CTA Text</Label>
                    <Input value={form.ctaText} onChange={(e) => setForm({ ...form, ctaText: e.target.value })} placeholder="e.g. Shop Now (optional)" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">Start Date</Label>
                    <DateTimePicker value={form.startsAt} onChange={(date) => setForm({ ...form, startsAt: date })} placeholder="Select start" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">End Date</Label>
                    <DateTimePicker value={form.expiresAt} onChange={(date) => setForm({ ...form, expiresAt: date })} placeholder="Select end" />
                  </div>
                </div>
              </>
            )}

            {/* UTM Tracking — shared by both */}
            <div className="border-t pt-4">
              <p className="text-sm font-medium text-muted-foreground mb-3">UTM Tracking (optional)</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Source</Label>
                  <Input value={form.utmSource} onChange={(e) => setForm({ ...form, utmSource: e.target.value })} placeholder="e.g. google" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Medium</Label>
                  <Input value={form.utmMedium} onChange={(e) => setForm({ ...form, utmMedium: e.target.value })} placeholder="e.g. cpc" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Campaign</Label>
                  <Input value={form.utmCampaign} onChange={(e) => setForm({ ...form, utmCampaign: e.target.value })} placeholder="e.g. summer_sale" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Content</Label>
                  <Input value={form.utmContent} onChange={(e) => setForm({ ...form, utmContent: e.target.value })} placeholder="e.g. banner_v2" />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label className="text-xs text-muted-foreground">Term</Label>
                  <Input value={form.utmTerm} onChange={(e) => setForm({ ...form, utmTerm: e.target.value })} placeholder="e.g. running+shoes" />
                </div>
              </div>
            </div>
          </div>

          {/* Story live preview */}
          {isStories && (
            <div className="hidden md:flex flex-col items-center gap-2 pt-2">
              <p className="text-xs text-muted-foreground">Preview</p>
              <div className="w-[220px] h-[390px] rounded-[1.8rem] border-[4px] border-foreground/20 bg-black overflow-hidden shadow-lg relative">
                {/* Status bar */}
                <div className="relative flex h-5 items-center justify-center">
                  <div className="absolute left-3 text-[8px] font-medium text-white/70">9:41</div>
                  <div className="h-[12px] w-12 rounded-full bg-white/10" />
                </div>
                {/* Progress bar */}
                <div className="px-2 pt-1 flex gap-1">
                  <div className="h-0.5 flex-1 rounded-full bg-white/60" />
                  <div className="h-0.5 flex-1 rounded-full bg-white/20" />
                  <div className="h-0.5 flex-1 rounded-full bg-white/20" />
                </div>
                {/* Story content */}
                <div
                  className="absolute inset-0 top-8 bottom-8 flex items-center justify-center"
                  style={form.storyType === 'text' ? { backgroundColor: form.storyBgColor || '#6366f1' } : undefined}
                >
                  {form.storyType === 'image' ? (
                    form.imageUrl && !imgError ? (
                      <img src={form.imageUrl} alt="" className="w-full h-full object-cover" onError={() => setImgError(true)} />
                    ) : (
                      <div className="text-center">
                        <Image className="mx-auto h-8 w-8 text-white/30" />
                        <p className="text-[10px] text-white/40 mt-1">Add image URL</p>
                      </div>
                    )
                  ) : (
                    <p
                      className="px-4 text-center text-sm font-medium leading-snug"
                      style={{ color: form.storyTextColor || '#ffffff' }}
                    >
                      {form.storyText || 'Your story text'}
                    </p>
                  )}
                </div>
                {/* CTA button */}
                {form.ctaText && (
                  <div className="absolute bottom-10 left-0 right-0 flex justify-center">
                    <div className="rounded-full bg-white/20 backdrop-blur-sm px-5 py-1.5 text-white text-xs font-medium">
                      {form.ctaText}
                    </div>
                  </div>
                )}
                {/* Home indicator */}
                <div className="absolute bottom-1 left-0 right-0 flex justify-center">
                  <div className="h-1 w-16 rounded-full bg-white/20" />
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={onSubmit} disabled={isPending || !isValid}>
            {isPending ? (
              <>
                <span className="h-4 w-4 mr-2 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Saving...
              </>
            ) : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
