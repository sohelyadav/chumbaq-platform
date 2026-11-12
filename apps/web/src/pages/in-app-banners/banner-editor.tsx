import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, ImageIcon, Type } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';

import {
  useBannerCategoryDetail,
  useCreateBannerCategory,
  useInAppBanners,
} from '@/hooks/use-inline-banners';
import { apiPost, apiPatch, apiGet } from '@/lib/api';
import { toast } from '@/components/ui/use-toast';
import { useQueryClient } from '@tanstack/react-query';

const ASPECT_RATIOS = [
  { label: '16:9', value: '16:9' },
  { label: '4:3', value: '4:3' },
  { label: '1:1', value: '1:1' },
  { label: '3:2', value: '3:2' },
  { label: '21:9', value: '21:9' },
  { label: '9:16', value: '9:16' },
];

const WIDGET_LAYOUTS: Record<string, { layout: string; label: string; itemLabel: string }> = {
  banners: { layout: 'single', label: 'Banner', itemLabel: 'banner' },
  carousels: { layout: 'carousel', label: 'Carousel', itemLabel: 'slide' },
  stories: { layout: 'single', label: 'Story', itemLabel: 'story' },
  grids: { layout: 'grid', label: 'Grid', itemLabel: 'tile' },
  'swipe-strips': { layout: 'swipe_strip', label: 'Swipe Strip', itemLabel: 'card' },
};

interface BannerForm {
  name: string;
  description: string;
  imageUrl: string;
  clickUrl: string;
  aspectRatio: string;
  customRatio: string;
  startsAt: Date | undefined;
  expiresAt: Date | undefined;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmContent: string;
  utmTerm: string;
  ctaText: string;
  storyType: 'image' | 'text';
  storyText: string;
  storyBgColor: string;
  storyTextColor: string;
  autoRotate: boolean;
  rotationInterval: string;
  heading: string;
  backgroundColor: string;
  padding: string;
  config: Record<string, any>;
}

const defaultForm: BannerForm = {
  name: '',
  description: '',
  imageUrl: '',
  clickUrl: '',
  aspectRatio: '16:9',
  customRatio: '',
  startsAt: undefined,
  expiresAt: undefined,
  utmSource: '',
  utmMedium: '',
  utmCampaign: '',
  utmContent: '',
  utmTerm: '',
  ctaText: '',
  storyType: 'image',
  storyText: '',
  storyBgColor: '#6366f1',
  storyTextColor: '#ffffff',
  autoRotate: true,
  rotationInterval: '5',
  heading: '',
  backgroundColor: '#ffffff',
  padding: '0',
  config: {},
};

export default function BannerEditorPage() {
  const { projectId, type, categoryId } = useParams<{ projectId: string; type: string; categoryId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isEdit = !!categoryId;
  const widgetInfo = WIDGET_LAYOUTS[type || ''] || WIDGET_LAYOUTS.banners;
  const isStory = type === 'stories';

  const { data: category } = useBannerCategoryDetail(isEdit ? categoryId : undefined);
  const { data: bannerItems } = useInAppBanners(isEdit ? categoryId : undefined);
  const createCategory = useCreateBannerCategory(projectId!);

  const [form, setForm] = useState<BannerForm>(defaultForm);
  const [saving, setSaving] = useState(false);
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    if (isEdit && category) {
      const ratio = category.aspectRatio || '16:9';
      const isPreset = ASPECT_RATIOS.some((r) => r.value === ratio);

      if (widgetInfo.layout !== 'single') {
        // Multi-item layouts: load container-level settings only
        setForm({
          ...defaultForm,
          name: category.name,
          description: (category as any).description || '',
          aspectRatio: isPreset ? ratio : 'custom',
          customRatio: isPreset ? '' : ratio,
          autoRotate: (category as any).autoRotate ?? true,
          rotationInterval: String((category as any).rotationInterval ?? 5),
          heading: (category as any).heading || '',
          backgroundColor: (category as any).backgroundColor || '#ffffff',
          padding: String((category as any).padding ?? 0),
          config: (category as any).config ?? {},
        });
      } else {
        // Single layout: load item-level fields as before
        const item = bannerItems?.[0];
        const meta = item?.metadata || {};
        setForm({
          ...defaultForm,
          name: category.name,
          aspectRatio: isPreset ? ratio : 'custom',
          customRatio: isPreset ? '' : ratio,
          imageUrl: item?.imageUrl || '',
          clickUrl: item?.clickUrl || '',
          ctaText: (item as any)?.ctaText || '',
          startsAt: item?.startsAt ? new Date(item.startsAt) : undefined,
          expiresAt: item?.expiresAt ? new Date(item.expiresAt) : undefined,
          utmSource: meta.utm_source || '',
          utmMedium: meta.utm_medium || '',
          utmCampaign: meta.utm_campaign || '',
          utmContent: meta.utm_content || '',
          utmTerm: meta.utm_term || '',
          storyType: meta.storyType || 'image',
          storyText: meta.storyText || '',
          storyBgColor: meta.backgroundColor || '#6366f1',
          storyTextColor: meta.textColor || '#ffffff',
          autoRotate: (category as any).autoRotate ?? true,
          rotationInterval: String((category as any).rotationInterval ?? 5),
          config: (category as any).config ?? {},
        });
      }
    }
  }, [isEdit, category, bannerItems, widgetInfo.layout]);

  const goBack = () => navigate(`/projects/${projectId}/widgets/${type}`);

  const effectiveRatio = form.aspectRatio === 'custom' ? form.customRatio : form.aspectRatio;

  const buildMetadata = () => {
    const meta: Record<string, string> = {};
    if (form.utmSource) meta.utm_source = form.utmSource;
    if (form.utmMedium) meta.utm_medium = form.utmMedium;
    if (form.utmCampaign) meta.utm_campaign = form.utmCampaign;
    if (form.utmContent) meta.utm_content = form.utmContent;
    if (form.utmTerm) meta.utm_term = form.utmTerm;
    return Object.keys(meta).length > 0 ? meta : undefined;
  };

  const isMultiItem = widgetInfo.layout !== 'single';

  const handleSave = async () => {
    if (!isStory && !form.name) { toast({ title: 'Name is required', variant: 'destructive' }); return; }
    if (!isMultiItem && !isStory && (!form.imageUrl || !form.clickUrl)) { toast({ title: 'Image URL and Click URL are required', variant: 'destructive' }); return; }
    if (isStory && form.storyType === 'image' && (!form.name || !form.imageUrl)) { toast({ title: 'Name and Image URL are required', variant: 'destructive' }); return; }
    if (isStory && form.storyType === 'text' && (!form.storyText || !form.storyBgColor)) { toast({ title: 'Story text and background color are required', variant: 'destructive' }); return; }
    if (form.aspectRatio === 'custom' && !/^\d+:\d+$/.test(form.customRatio)) { toast({ title: 'Enter a valid custom ratio (e.g. 5:4)', variant: 'destructive' }); return; }
    if (!isMultiItem && form.startsAt && form.expiresAt && form.startsAt >= form.expiresAt) { toast({ title: 'End date must be after start date', variant: 'destructive' }); return; }

    setSaving(true);
    try {
      if (isMultiItem) {
        // Multi-item layouts: only save container settings, no banner items
        if (isEdit) {
          await apiPatch(`/api/banner-categories/${categoryId}`, {
            name: form.name,
            description: form.description || undefined,
            aspectRatio: effectiveRatio,
            autoRotate: form.autoRotate,
            rotationInterval: parseInt(form.rotationInterval, 10) || 5,
            heading: form.heading || undefined,
            backgroundColor: form.backgroundColor,
            padding: parseInt(form.padding, 10) || 0,
            config: Object.keys(form.config).length > 0 ? form.config : undefined,
          });
          queryClient.invalidateQueries({ queryKey: ['banner-categories', projectId] });
          queryClient.invalidateQueries({ queryKey: ['banner-category', categoryId] });
          toast({ title: `${widgetInfo.label} updated` });
          navigate(`/projects/${projectId}/widgets/${type}/${categoryId}`);
        } else {
          const cat = await createCategory.mutateAsync({
            name: form.name,
            description: form.description || undefined,
            layout: widgetInfo.layout,
            aspectRatio: effectiveRatio,
            autoRotate: form.autoRotate,
            rotationInterval: parseInt(form.rotationInterval, 10) || 5,
            heading: form.heading || undefined,
            backgroundColor: form.backgroundColor,
            padding: parseInt(form.padding, 10) || 0,
            config: Object.keys(form.config).length > 0 ? form.config : undefined,
          } as any);
          toast({ title: `${widgetInfo.label} created` });
          navigate(`/projects/${projectId}/widgets/${type}/${cat.id}`);
        }
      } else {
        // Single layout: full item creation/update as before
        const storyMeta: Record<string, any> = {};
        if (isStory) {
          storyMeta.storyType = form.storyType;
          if (form.storyType === 'text') {
            storyMeta.storyText = form.storyText;
            storyMeta.backgroundColor = form.storyBgColor;
            storyMeta.textColor = form.storyTextColor;
          }
        }
        const utmMeta = buildMetadata() || {};
        const mergedMeta = { ...utmMeta, ...storyMeta };
        const finalMeta = Object.keys(mergedMeta).length > 0 ? mergedMeta : undefined;

        const itemTitle = isStory
          ? form.storyType === 'text' ? form.storyText.slice(0, 50) : form.name
          : form.name;
        const itemImageUrl = isStory && form.storyType === 'text' ? undefined : form.imageUrl;
        const itemClickUrl = isStory ? (form.clickUrl || undefined) : form.clickUrl;

        if (isEdit) {
          await apiPatch(`/api/banner-categories/${categoryId}`, {
            name: isStory && form.storyType === 'text' ? form.storyText.slice(0, 50) : form.name,
            aspectRatio: isStory && form.storyType === 'text' ? '9:16' : effectiveRatio,
            autoRotate: form.autoRotate,
            rotationInterval: parseInt(form.rotationInterval, 10) || 5,
            config: Object.keys(form.config).length > 0 ? form.config : undefined,
          });
          const items = await apiGet<any[]>(`/api/banner-categories/${categoryId}/banners`);
          if (items?.[0]?.id) {
            await apiPatch(`/api/in-app-banners/${items[0].id}`, {
              title: itemTitle,
              imageUrl: itemImageUrl,
              clickUrl: itemClickUrl,
              ctaText: form.ctaText || undefined,
              startsAt: form.startsAt?.toISOString() || undefined,
              expiresAt: form.expiresAt?.toISOString() || undefined,
              metadata: finalMeta,
            });
          }
          queryClient.invalidateQueries({ queryKey: ['banner-categories', projectId] });
          queryClient.invalidateQueries({ queryKey: ['banner-category', categoryId] });
          queryClient.invalidateQueries({ queryKey: ['in-app-banners', categoryId] });
          toast({ title: `${widgetInfo.label} updated` });
        } else {
          const cat = await createCategory.mutateAsync({
            name: isStory && form.storyType === 'text' ? form.storyText.slice(0, 50) : form.name,
            layout: isStory ? 'stories' : widgetInfo.layout,
            aspectRatio: isStory && form.storyType === 'text' ? '9:16' : effectiveRatio,
            autoRotate: form.autoRotate,
            rotationInterval: parseInt(form.rotationInterval, 10) || 5,
            config: Object.keys(form.config).length > 0 ? form.config : undefined,
          } as any);
          if (cat?.id) {
            await apiPost(`/api/banner-categories/${cat.id}/banners`, {
              title: itemTitle,
              imageUrl: itemImageUrl,
              clickUrl: itemClickUrl,
              ctaText: form.ctaText || undefined,
              startsAt: form.startsAt?.toISOString() || undefined,
              expiresAt: form.expiresAt?.toISOString() || undefined,
              sortOrder: 0,
              metadata: finalMeta,
            });
          }
          toast({ title: `${widgetInfo.label} created` });
        }
        goBack();
      }
    } catch {
      toast({ title: `Failed to ${isEdit ? 'update' : 'create'} ${widgetInfo.itemLabel}`, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const updateConfig = (key: string, value: any) => {
    setForm((prev) => ({ ...prev, config: { ...prev.config, [key]: value } }));
  };

  const hasValidCustomRatio = form.aspectRatio !== 'custom' || /^\d+:\d+$/.test(form.customRatio);
  const isFormValid = isMultiItem
    ? !!(form.name && hasValidCustomRatio)
    : isStory
      ? form.storyType === 'image'
        ? !!(form.name && form.imageUrl && hasValidCustomRatio)
        : !!(form.storyText && form.storyBgColor && (!form.ctaText || form.clickUrl))
      : !!(form.name && form.imageUrl && form.clickUrl && hasValidCustomRatio);

  const ratioMatch = effectiveRatio?.match(/^(\d+):(\d+)$/);
  const ratioW = ratioMatch ? Number(ratioMatch[1]) : 16;
  const ratioH = ratioMatch ? Number(ratioMatch[2]) : 9;
  const maxPhoneContent = 420;
  const previewWidth = Math.min(268, maxPhoneContent * (ratioW / ratioH));
  const bannerHeight = previewWidth * (ratioH / ratioW);

  return (
    <div className="max-w-6xl">
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={goBack} className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-lg font-semibold">{isEdit ? 'Edit' : 'New'} {widgetInfo.label}</h1>
        </div>
        <div className="flex items-center gap-2 self-end sm:self-auto">
          <Button variant="outline" size="sm" onClick={goBack}>Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={saving || !isFormValid}>
            {saving ? 'Saving...' : isEdit ? 'Save' : 'Create'}
          </Button>
        </div>
      </div>

      {isMultiItem ? (
        /* ── Multi-item layout: single-column, container settings only ── */
        <div className="max-w-2xl">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-base">{widgetInfo.label} Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="banner-name">Name <span className="text-destructive">*</span></Label>
                <Input
                  id="banner-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder={`e.g. Summer Sale ${widgetInfo.label}`}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="description">Description <span className="font-normal text-muted-foreground">(optional)</span></Label>
                <Input
                  id="description"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Brief description of this widget"
                />
              </div>

              <div className="space-y-1.5">
                <Label>Aspect Ratio</Label>
                <Select
                  value={form.aspectRatio}
                  onValueChange={(v) => setForm({ ...form, aspectRatio: v })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ASPECT_RATIOS.map((r) => (
                      <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                    ))}
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {form.aspectRatio === 'custom' && (
                <div className="space-y-1.5">
                  <Label htmlFor="custom-ratio">Custom Ratio</Label>
                  <Input
                    id="custom-ratio"
                    value={form.customRatio}
                    onChange={(e) => setForm({ ...form, customRatio: e.target.value })}
                    placeholder="e.g. 5:4"
                  />
                </div>
              )}

              {/* Layout-specific settings */}
              <div className="space-y-3 rounded-md border p-4">
                <Label className="text-sm font-medium">{widgetInfo.label} Settings</Label>

                {/* Carousel settings */}
                {widgetInfo.layout === 'carousel' && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="auto-rotate" className="text-sm">Auto Rotate</Label>
                      <Switch
                        id="auto-rotate"
                        checked={form.autoRotate}
                        onCheckedChange={(checked) => setForm({ ...form, autoRotate: checked })}
                      />
                    </div>
                    {form.autoRotate && (
                      <div className="space-y-1.5">
                        <Label htmlFor="rotation-interval" className="text-xs text-muted-foreground">Rotation Interval (seconds)</Label>
                        <Input
                          id="rotation-interval"
                          type="number"
                          min="1"
                          value={form.rotationInterval}
                          onChange={(e) => setForm({ ...form, rotationInterval: e.target.value })}
                        />
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <Label htmlFor="show-dots" className="text-sm">Show Dots</Label>
                      <Switch
                        id="show-dots"
                        checked={form.config.showDots ?? true}
                        onCheckedChange={(checked) => updateConfig('showDots', checked)}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <Label htmlFor="show-arrows" className="text-sm">Show Arrows</Label>
                      <Switch
                        id="show-arrows"
                        checked={form.config.showArrows ?? true}
                        onCheckedChange={(checked) => updateConfig('showArrows', checked)}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <Label htmlFor="infinite-loop" className="text-sm">Infinite Loop</Label>
                      <Switch
                        id="infinite-loop"
                        checked={form.config.infinite ?? true}
                        onCheckedChange={(checked) => updateConfig('infinite', checked)}
                      />
                    </div>
                  </div>
                )}

                {/* Grid settings */}
                {widgetInfo.layout === 'grid' && (
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="grid-columns" className="text-xs text-muted-foreground">Columns</Label>
                      <Input
                        id="grid-columns"
                        type="number"
                        min="1"
                        max="6"
                        value={form.config.columns ?? 2}
                        onChange={(e) => updateConfig('columns', parseInt(e.target.value, 10) || 2)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="grid-gap" className="text-xs text-muted-foreground">Gap (px)</Label>
                      <Input
                        id="grid-gap"
                        type="number"
                        min="0"
                        value={form.config.gap ?? 8}
                        onChange={(e) => updateConfig('gap', parseInt(e.target.value, 10) || 0)}
                      />
                    </div>
                  </div>
                )}

                {/* Stories settings */}
                {widgetInfo.layout === 'stories' && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="auto-advance" className="text-sm">Auto Advance</Label>
                      <Switch
                        id="auto-advance"
                        checked={form.config.autoAdvance ?? true}
                        onCheckedChange={(checked) => updateConfig('autoAdvance', checked)}
                      />
                    </div>
                    {(form.config.autoAdvance ?? true) && (
                      <div className="space-y-1.5">
                        <Label htmlFor="advance-interval" className="text-xs text-muted-foreground">Advance Interval (seconds)</Label>
                        <Input
                          id="advance-interval"
                          type="number"
                          min="1"
                          value={form.config.advanceInterval ?? 5}
                          onChange={(e) => updateConfig('advanceInterval', parseInt(e.target.value, 10) || 5)}
                        />
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <Label htmlFor="show-progress" className="text-sm">Show Progress Bar</Label>
                      <Switch
                        id="show-progress"
                        checked={form.config.showProgressBar ?? true}
                        onCheckedChange={(checked) => updateConfig('showProgressBar', checked)}
                      />
                    </div>
                  </div>
                )}

                {/* Swipe Strip settings */}
                {widgetInfo.layout === 'swipe_strip' && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="strip-auto-rotate" className="text-sm">Auto Rotate</Label>
                      <Switch
                        id="strip-auto-rotate"
                        checked={form.autoRotate}
                        onCheckedChange={(checked) => setForm({ ...form, autoRotate: checked })}
                      />
                    </div>
                    {form.autoRotate && (
                      <div className="space-y-1.5">
                        <Label htmlFor="strip-rotation-interval" className="text-xs text-muted-foreground">Rotation Interval (seconds)</Label>
                        <Input
                          id="strip-rotation-interval"
                          type="number"
                          min="1"
                          value={form.rotationInterval}
                          onChange={(e) => setForm({ ...form, rotationInterval: e.target.value })}
                        />
                      </div>
                    )}
                    <div className="space-y-1.5">
                      <Label htmlFor="item-width" className="text-xs text-muted-foreground">Item Width (px)</Label>
                      <Input
                        id="item-width"
                        type="number"
                        min="40"
                        value={form.config.itemWidth ?? 120}
                        onChange={(e) => updateConfig('itemWidth', parseInt(e.target.value, 10) || 120)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="strip-gap" className="text-xs text-muted-foreground">Gap (px)</Label>
                      <Input
                        id="strip-gap"
                        type="number"
                        min="0"
                        value={form.config.gap ?? 8}
                        onChange={(e) => updateConfig('gap', parseInt(e.target.value, 10) || 0)}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <Label htmlFor="snap-to-item" className="text-sm">Snap to Item</Label>
                      <Switch
                        id="snap-to-item"
                        checked={form.config.snapToItem ?? true}
                        onCheckedChange={(checked) => updateConfig('snapToItem', checked)}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Container appearance settings */}
              <div className="space-y-3 border-t pt-4">
                <Label className="text-sm font-medium">Appearance</Label>
                <div className="space-y-1.5">
                  <Label htmlFor="heading">Heading <span className="font-normal text-muted-foreground">(optional)</span></Label>
                  <Input
                    id="heading"
                    value={form.heading}
                    onChange={(e) => setForm({ ...form, heading: e.target.value })}
                    placeholder="e.g. Featured Offers"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bg-color">Background Color <span className="font-normal text-muted-foreground">(optional)</span></Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="bg-color"
                      type="color"
                      value={form.backgroundColor}
                      onChange={(e) => setForm({ ...form, backgroundColor: e.target.value })}
                      className="h-9 w-12 cursor-pointer p-1"
                    />
                    <Input
                      value={form.backgroundColor}
                      onChange={(e) => setForm({ ...form, backgroundColor: e.target.value })}
                      placeholder="#ffffff"
                      className="flex-1"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="padding">Padding (px) <span className="font-normal text-muted-foreground">(optional)</span></Label>
                  <Input
                    id="padding"
                    type="number"
                    min="0"
                    value={form.padding}
                    onChange={(e) => setForm({ ...form, padding: e.target.value })}
                    placeholder="0"
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : (
        /* ── Single layout: two-column with preview panel ── */
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px]">
          {/* Form */}
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-base">{widgetInfo.label} Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Story type toggle */}
              {isStory && (
                <div className="flex rounded-lg bg-muted p-1 w-fit">
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, storyType: 'image' })}
                    className={cn(
                      'flex items-center gap-1.5 rounded-md px-4 py-1.5 text-sm font-medium transition-all',
                      form.storyType === 'image' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <ImageIcon className="h-3.5 w-3.5" /> Image
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, storyType: 'text', aspectRatio: '9:16' })}
                    className={cn(
                      'flex items-center gap-1.5 rounded-md px-4 py-1.5 text-sm font-medium transition-all',
                      form.storyType === 'text' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <Type className="h-3.5 w-3.5" /> Text
                  </button>
                </div>
              )}

              {isStory && form.storyType === 'text' ? (
                /* === Text story fields === */
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="story-text">Story Text <span className="text-destructive">*</span></Label>
                    <Textarea
                      id="story-text"
                      value={form.storyText}
                      onChange={(e) => setForm({ ...form, storyText: e.target.value })}
                      placeholder="Enter your story text..."
                      rows={4}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label>Background Color <span className="text-destructive">*</span></Label>
                    <div className="flex items-center gap-2">
                      <Input
                        type="color"
                        value={form.storyBgColor}
                        onChange={(e) => setForm({ ...form, storyBgColor: e.target.value })}
                        className="h-9 w-12 cursor-pointer p-1"
                      />
                      <Input
                        value={form.storyBgColor}
                        onChange={(e) => setForm({ ...form, storyBgColor: e.target.value })}
                        placeholder="#6366f1"
                        className="flex-1"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label>Text Color</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        type="color"
                        value={form.storyTextColor}
                        onChange={(e) => setForm({ ...form, storyTextColor: e.target.value })}
                        className="h-9 w-12 cursor-pointer p-1"
                      />
                      <Input
                        value={form.storyTextColor}
                        onChange={(e) => setForm({ ...form, storyTextColor: e.target.value })}
                        placeholder="#ffffff"
                        className="flex-1"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="cta-text">CTA Text <span className="font-normal text-muted-foreground">(optional)</span></Label>
                    <Input
                      id="cta-text"
                      value={form.ctaText}
                      onChange={(e) => setForm({ ...form, ctaText: e.target.value })}
                      placeholder="e.g. Learn More"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="click-url">Click URL {form.ctaText ? <span className="text-destructive">*</span> : <span className="font-normal text-muted-foreground">(optional)</span>}</Label>
                    <Input
                      id="click-url"
                      value={form.clickUrl}
                      onChange={(e) => setForm({ ...form, clickUrl: e.target.value })}
                      placeholder="https://example.com/offer"
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Start Date <span className="font-normal text-muted-foreground">(optional)</span></Label>
                      <DateTimePicker
                        value={form.startsAt}
                        onChange={(date) => setForm({ ...form, startsAt: date })}
                        placeholder="Select start"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>End Date <span className="font-normal text-muted-foreground">(optional)</span></Label>
                      <DateTimePicker
                        value={form.expiresAt}
                        onChange={(date) => setForm({ ...form, expiresAt: date })}
                        placeholder="Select end"
                      />
                    </div>
                  </div>

                  {/* UTM */}
                  <div className="space-y-3 border-t pt-4">
                    <Label className="text-sm font-medium">UTM Tracking <span className="font-normal text-muted-foreground">(optional)</span></Label>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="utm-source" className="text-xs text-muted-foreground">Source</Label>
                        <Input id="utm-source" value={form.utmSource} onChange={(e) => setForm({ ...form, utmSource: e.target.value })} placeholder="e.g. app, website" />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="utm-medium" className="text-xs text-muted-foreground">Medium</Label>
                        <Input id="utm-medium" value={form.utmMedium} onChange={(e) => setForm({ ...form, utmMedium: e.target.value })} placeholder="e.g. banner, email" />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="utm-campaign" className="text-xs text-muted-foreground">Campaign</Label>
                        <Input id="utm-campaign" value={form.utmCampaign} onChange={(e) => setForm({ ...form, utmCampaign: e.target.value })} placeholder="e.g. summer_sale_2025" />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="utm-content" className="text-xs text-muted-foreground">Content</Label>
                        <Input id="utm-content" value={form.utmContent} onChange={(e) => setForm({ ...form, utmContent: e.target.value })} placeholder="e.g. hero_v1" />
                      </div>
                      <div className="space-y-1.5 sm:col-span-2">
                        <Label htmlFor="utm-term" className="text-xs text-muted-foreground">Term</Label>
                        <Input id="utm-term" value={form.utmTerm} onChange={(e) => setForm({ ...form, utmTerm: e.target.value })} placeholder="e.g. running+shoes" />
                      </div>
                    </div>
                  </div>
                </>
              ) : isStory && form.storyType === 'image' ? (
                /* === Image story fields === */
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="banner-name">Name <span className="text-destructive">*</span></Label>
                    <Input
                      id="banner-name"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      placeholder="e.g. Promo Story"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="image-url">Image URL <span className="text-destructive">*</span></Label>
                    <Input
                      id="image-url"
                      value={form.imageUrl}
                      onChange={(e) => { setForm({ ...form, imageUrl: e.target.value }); setImgError(false); }}
                      placeholder="https://example.com/story.jpg"
                    />
                    {imgError && <p className="text-xs text-destructive">Failed to load image preview. Check the URL.</p>}
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="cta-text">CTA Text <span className="font-normal text-muted-foreground">(optional)</span></Label>
                    <Input
                      id="cta-text"
                      value={form.ctaText}
                      onChange={(e) => setForm({ ...form, ctaText: e.target.value })}
                      placeholder="e.g. Shop Now"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="click-url">Click URL {form.ctaText ? <span className="text-destructive">*</span> : <span className="font-normal text-muted-foreground">(optional)</span>}</Label>
                    <Input
                      id="click-url"
                      value={form.clickUrl}
                      onChange={(e) => setForm({ ...form, clickUrl: e.target.value })}
                      placeholder="https://example.com/offer"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label>Aspect Ratio</Label>
                    <Select
                      value={form.aspectRatio}
                      onValueChange={(v) => setForm({ ...form, aspectRatio: v })}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {ASPECT_RATIOS.map((r) => (
                          <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                        ))}
                        <SelectItem value="custom">Custom</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {form.aspectRatio === 'custom' && (
                    <div className="space-y-1.5">
                      <Label htmlFor="custom-ratio">Custom Ratio</Label>
                      <Input
                        id="custom-ratio"
                        value={form.customRatio}
                        onChange={(e) => setForm({ ...form, customRatio: e.target.value })}
                        placeholder="e.g. 5:4"
                      />
                    </div>
                  )}

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Start Date <span className="font-normal text-muted-foreground">(optional)</span></Label>
                      <DateTimePicker
                        value={form.startsAt}
                        onChange={(date) => setForm({ ...form, startsAt: date })}
                        placeholder="Select start"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>End Date <span className="font-normal text-muted-foreground">(optional)</span></Label>
                      <DateTimePicker
                        value={form.expiresAt}
                        onChange={(date) => setForm({ ...form, expiresAt: date })}
                        placeholder="Select end"
                      />
                    </div>
                  </div>

                  {/* UTM */}
                  <div className="space-y-3 border-t pt-4">
                    <Label className="text-sm font-medium">UTM Tracking <span className="font-normal text-muted-foreground">(optional)</span></Label>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="utm-source" className="text-xs text-muted-foreground">Source</Label>
                        <Input id="utm-source" value={form.utmSource} onChange={(e) => setForm({ ...form, utmSource: e.target.value })} placeholder="e.g. app, website" />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="utm-medium" className="text-xs text-muted-foreground">Medium</Label>
                        <Input id="utm-medium" value={form.utmMedium} onChange={(e) => setForm({ ...form, utmMedium: e.target.value })} placeholder="e.g. banner, email" />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="utm-campaign" className="text-xs text-muted-foreground">Campaign</Label>
                        <Input id="utm-campaign" value={form.utmCampaign} onChange={(e) => setForm({ ...form, utmCampaign: e.target.value })} placeholder="e.g. summer_sale_2025" />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="utm-content" className="text-xs text-muted-foreground">Content</Label>
                        <Input id="utm-content" value={form.utmContent} onChange={(e) => setForm({ ...form, utmContent: e.target.value })} placeholder="e.g. hero_v1" />
                      </div>
                      <div className="space-y-1.5 sm:col-span-2">
                        <Label htmlFor="utm-term" className="text-xs text-muted-foreground">Term</Label>
                        <Input id="utm-term" value={form.utmTerm} onChange={(e) => setForm({ ...form, utmTerm: e.target.value })} placeholder="e.g. running+shoes" />
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                /* === Standard banner fields === */
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="banner-name">Name <span className="text-destructive">*</span></Label>
                    <Input
                      id="banner-name"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      placeholder="e.g. Summer Sale Banner"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="image-url">Image URL <span className="text-destructive">*</span></Label>
                    <Input
                      id="image-url"
                      value={form.imageUrl}
                      onChange={(e) => { setForm({ ...form, imageUrl: e.target.value }); setImgError(false); }}
                      placeholder="https://example.com/banner.jpg"
                    />
                    {imgError && <p className="text-xs text-destructive">Failed to load image preview. Check the URL.</p>}
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="click-url">Click URL <span className="text-destructive">*</span></Label>
                    <Input
                      id="click-url"
                      value={form.clickUrl}
                      onChange={(e) => setForm({ ...form, clickUrl: e.target.value })}
                      placeholder="https://example.com/offer"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label>Aspect Ratio</Label>
                    <Select
                      value={form.aspectRatio}
                      onValueChange={(v) => setForm({ ...form, aspectRatio: v })}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {ASPECT_RATIOS.map((r) => (
                          <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                        ))}
                        <SelectItem value="custom">Custom</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {form.aspectRatio === 'custom' && (
                    <div className="space-y-1.5">
                      <Label htmlFor="custom-ratio">Custom Ratio</Label>
                      <Input
                        id="custom-ratio"
                        value={form.customRatio}
                        onChange={(e) => setForm({ ...form, customRatio: e.target.value })}
                        placeholder="e.g. 5:4"
                      />
                    </div>
                  )}

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Start Date <span className="font-normal text-muted-foreground">(optional)</span></Label>
                      <DateTimePicker
                        value={form.startsAt}
                        onChange={(date) => setForm({ ...form, startsAt: date })}
                        placeholder="Select start"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>End Date <span className="font-normal text-muted-foreground">(optional)</span></Label>
                      <DateTimePicker
                        value={form.expiresAt}
                        onChange={(date) => setForm({ ...form, expiresAt: date })}
                        placeholder="Select end"
                      />
                    </div>
                  </div>

                  {/* UTM & Campaign Tracking */}
                  <div className="space-y-3 border-t pt-4">
                    <Label className="text-sm font-medium">UTM Tracking <span className="font-normal text-muted-foreground">(optional)</span></Label>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="utm-source" className="text-xs text-muted-foreground">Source</Label>
                        <Input
                          id="utm-source"
                          value={form.utmSource}
                          onChange={(e) => setForm({ ...form, utmSource: e.target.value })}
                          placeholder="e.g. app, website"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="utm-medium" className="text-xs text-muted-foreground">Medium</Label>
                        <Input
                          id="utm-medium"
                          value={form.utmMedium}
                          onChange={(e) => setForm({ ...form, utmMedium: e.target.value })}
                          placeholder="e.g. banner, email"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="utm-campaign" className="text-xs text-muted-foreground">Campaign</Label>
                        <Input
                          id="utm-campaign"
                          value={form.utmCampaign}
                          onChange={(e) => setForm({ ...form, utmCampaign: e.target.value })}
                          placeholder="e.g. summer_sale_2025"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="utm-content" className="text-xs text-muted-foreground">Content</Label>
                        <Input
                          id="utm-content"
                          value={form.utmContent}
                          onChange={(e) => setForm({ ...form, utmContent: e.target.value })}
                          placeholder="e.g. hero_v1"
                        />
                      </div>
                      <div className="space-y-1.5 sm:col-span-2">
                        <Label htmlFor="utm-term" className="text-xs text-muted-foreground">Term</Label>
                        <Input
                          id="utm-term"
                          value={form.utmTerm}
                          onChange={(e) => setForm({ ...form, utmTerm: e.target.value })}
                          placeholder="e.g. running+shoes"
                        />
                      </div>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Preview panel */}
          <div className="lg:sticky lg:top-6">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Preview</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex justify-center">
                  <div className="w-[280px] h-[540px] overflow-hidden rounded-[2rem] border-[5px] border-foreground/20 bg-background shadow-lg">
                    {/* Status bar */}
                    <div className="relative flex h-6 items-center justify-center">
                      <div className="absolute left-4 text-[9px] font-medium text-muted-foreground">9:41</div>
                      <div className="h-[16px] w-16 rounded-full bg-foreground/90" />
                    </div>

                    {isStory && form.storyType === 'text' ? (
                      /* Story text preview - full screen */
                      <div
                        className="relative flex flex-col items-center justify-center px-4"
                        style={{
                          backgroundColor: form.storyBgColor || '#6366f1',
                          height: 'calc(100% - 32px)',
                        }}
                      >
                        <p
                          className="text-center text-sm font-semibold leading-snug break-words max-w-full"
                          style={{ color: form.storyTextColor || '#ffffff' }}
                        >
                          {form.storyText || 'Your story text here...'}
                        </p>
                        {form.ctaText && (
                          <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
                            <div
                              className="rounded-full px-5 py-1.5 text-xs font-medium"
                              style={{
                                backgroundColor: form.storyTextColor || '#ffffff',
                                color: form.storyBgColor || '#6366f1',
                              }}
                            >
                              {form.ctaText}
                            </div>
                          </div>
                        )}
                        {/* Home indicator */}
                        <div className="absolute bottom-2 left-1/2 -translate-x-1/2">
                          <div className="h-1 w-20 rounded-full bg-white/30" />
                        </div>
                      </div>
                    ) : (
                      <>
                        {/* Banner */}
                        <div className="px-3 pt-1">
                          <div
                            className="flex w-full items-center justify-center overflow-hidden rounded-lg bg-muted/50"
                            style={{ height: bannerHeight }}
                          >
                            {form.imageUrl && !imgError ? (
                              <img
                                src={form.imageUrl}
                                alt="Preview"
                                className="h-full w-full object-cover"
                                onError={() => setImgError(true)}
                              />
                            ) : (
                              <div className="text-center">
                                <ImageIcon className="mx-auto h-6 w-6 text-muted-foreground/40" />
                                <p className="mt-1 text-[10px] text-muted-foreground/50">{isStory ? 'Story preview' : 'Banner preview'}</p>
                              </div>
                            )}
                          </div>
                        </div>

                        {/* App content skeleton */}
                        <div className="px-3 py-3 space-y-3">
                          {/* Section title */}
                          <div className="flex items-center justify-between">
                            <div className="h-2.5 w-24 rounded bg-muted/80" />
                            <div className="h-2 w-12 rounded bg-muted/50" />
                          </div>

                          {/* Product cards row */}
                          <div className="flex gap-2">
                            {[1, 2, 3].map((i) => (
                              <div key={i} className="flex-1 space-y-1.5">
                                <div className="h-14 rounded-md bg-muted/40" />
                                <div className="h-1.5 w-4/5 rounded bg-muted/50" />
                                <div className="h-1.5 w-1/2 rounded bg-muted/30" />
                              </div>
                            ))}
                          </div>

                          {/* Another section */}
                          <div className="h-2.5 w-20 rounded bg-muted/80" />

                          {/* List items */}
                          {[1, 2].map((i) => (
                            <div key={i} className="flex items-center gap-2">
                              <div className="h-9 w-9 shrink-0 rounded-lg bg-muted/40" />
                              <div className="flex-1 space-y-1">
                                <div className="h-1.5 w-3/4 rounded bg-muted/50" />
                                <div className="h-1.5 w-1/2 rounded bg-muted/30" />
                              </div>
                              <div className="h-5 w-10 rounded-full bg-muted/30" />
                            </div>
                          ))}
                        </div>

                        {/* Home indicator */}
                        <div className="flex justify-center pb-2">
                          <div className="h-1 w-20 rounded-full bg-foreground/15" />
                        </div>
                      </>
                    )}
                  </div>
                </div>
                <p className="mt-3 text-center text-xs text-muted-foreground">
                  {isStory && form.storyType === 'text' ? '9:16' : effectiveRatio || '16:9'} aspect ratio
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
