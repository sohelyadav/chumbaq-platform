import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { format } from 'date-fns';
import {
  Copy, Check, ExternalLink, Pencil, Trash2, ArrowLeft, Download,
  FlaskConical, Plus, MousePointerClick, Users, Store, Smartphone, TrendingUp,
  MoreHorizontal, Globe, BarChart3, TestTube, QrCode,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { useLink, useDeleteLink, useLinkQrCode } from '@/hooks/use-links';
import { useLinkAnalytics } from '@/hooks/use-analytics';
import { useLinkVariants, useCreateLinkVariant, useDeleteLinkVariant } from '@/hooks/use-link-variants';
import api from '@/lib/api';
import { ClicksChart, ranges as clickRanges } from '@/components/analytics/clicks-chart';
import { DeviceBreakdown } from '@/components/analytics/device-breakdown';
import { ReferrerTable } from '@/components/analytics/referrer-table';
import { GeoTable } from '@/components/analytics/geo-table';
import { ConversionFunnel } from '@/components/analytics/conversion-funnel';
import { toast } from '@/components/ui/use-toast';
import { useBreadcrumb } from '@/hooks/use-breadcrumb';

export default function LinkDetailPage() {
  const { projectId, linkId } = useParams<{ projectId: string; linkId: string }>();
  const navigate = useNavigate();
  const { data: link, isLoading } = useLink(linkId);
  const { data: analytics } = useLinkAnalytics(linkId);
  const { data: qrData } = useLinkQrCode(linkId);
  const { data: variants } = useLinkVariants(linkId);
  const createVariant = useCreateLinkVariant(linkId!);
  const deleteVariant = useDeleteLinkVariant(linkId!);
  const deleteLink = useDeleteLink();
  const [copied, setCopied] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [showAddVariant, setShowAddVariant] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [clickRangeIdx, setClickRangeIdx] = useState(0);
  const [variantForm, setVariantForm] = useState({ name: '', longUrl: '', weight: 50 });
  const { setOverride } = useBreadcrumb();

  // Set breadcrumb with link name + status
  useEffect(() => {
    if (!link) return;
    const isExpired = link.expiresAt && new Date(link.expiresAt) < new Date();
    const badgeVariant = !link.isActive ? 'secondary' : isExpired ? 'destructive' : 'default';
    const badgeText = !link.isActive ? 'Inactive' : isExpired ? 'Expired' : 'Active';
    setOverride({
      label: link.title || link.shortCode,
      badge: { text: badgeText, variant: badgeVariant },
    });
    return () => setOverride(null);
  }, [link, setOverride]);

  const shortUrl = link ? `${window.location.origin}/${link.shortCode}` : '';

  const copyToClipboard = async () => {
    await navigator.clipboard.writeText(shortUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDelete = async () => {
    if (!linkId) return;
    try {
      await deleteLink.mutateAsync(linkId);
      toast({ title: 'Link deleted' });
      navigate(`/projects/${projectId}/links`);
    } catch {
      toast({ title: 'Error', description: 'Failed to delete link', variant: 'destructive' });
    }
    setShowDelete(false);
  };

  const handleExportCsv = async () => {
    try {
      const response = await api.get(`/api/links/${linkId}/analytics/export`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `analytics-${linkId}.csv`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      toast({ title: 'Export failed', variant: 'destructive' });
    }
  };

  const handleDownloadSvg = async () => {
    try {
      const response = await api.get(`/api/links/${linkId}/qr`, { params: { format: 'svg' } });
      const svgData = response.data?.data?.qrCode || response.data?.qrCode || response.data;
      const blob = new Blob([svgData], { type: 'image/svg+xml' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `qr-${link?.shortCode}.svg`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      toast({ title: 'Download failed', variant: 'destructive' });
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-6 w-48 animate-pulse rounded bg-muted" />
        <div className="h-10 animate-pulse rounded bg-muted" />
        <div className="h-64 animate-pulse rounded-lg bg-muted" />
      </div>
    );
  }

  if (!link) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <p className="text-lg text-muted-foreground">Link not found</p>
        <Button variant="outline" onClick={() => navigate(`/projects/${projectId}/links`)}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back to links
        </Button>
      </div>
    );
  }

  const getStatus = () => {
    if (!link.isActive) return { label: 'Inactive', variant: 'secondary' as const };
    if (link.expiresAt && new Date(link.expiresAt) < new Date())
      return { label: 'Expired', variant: 'destructive' as const };
    return { label: 'Active', variant: 'default' as const };
  };
  const status = getStatus();

  const hasDeepLink = !!(link?.iosUrl || link?.androidUrl);
  const stats = analytics
    ? [
        { label: 'Total Clicks', value: analytics.totalClicks, icon: MousePointerClick, configured: true },
        { label: 'Unique Visitors', value: analytics.uniqueVisitors, icon: Users, configured: true },
        { label: 'Store Redirects', value: analytics.storeRedirects, icon: Store, configured: hasDeepLink },
        { label: 'Installs', value: analytics.matchedInstalls, icon: Smartphone, configured: hasDeepLink },
        { label: 'Conversion', value: `${(analytics.conversionRate * 100).toFixed(1)}%`, icon: TrendingUp, configured: hasDeepLink },
      ]
    : [];

  return (
    <div>
      {/* Sticky tab bar — offset main padding so it sits flush to the top */}
      <Tabs defaultValue="overview" className="space-y-4">
        <div className="sticky top-[-1.25rem] lg:top-[-1.75rem] z-[1200] -mx-4 lg:-mx-6 bg-background flex items-center justify-between px-4 lg:px-6 py-1.5 border-b">
          <TabsList>
            <TabsTrigger value="overview" className="gap-1.5">
              <BarChart3 className="h-3.5 w-3.5" /> Overview
            </TabsTrigger>
            <TabsTrigger value="geography" className="gap-1.5">
              <Globe className="h-3.5 w-3.5" /> Geography
            </TabsTrigger>
            <TabsTrigger value="attribution" className="gap-1.5">
              <TrendingUp className="h-3.5 w-3.5" /> Referrers & Conversions
            </TabsTrigger>
            <TabsTrigger value="ab" className="gap-1.5">
              <TestTube className="h-3.5 w-3.5" /> A/B Testing
            </TabsTrigger>
          </TabsList>

          {/* Actions menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link to={`/projects/${projectId}/links/${linkId}/edit`}>
                  <Pencil className="mr-2 h-3.5 w-3.5" /> Edit Link
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleExportCsv}>
                <Download className="mr-2 h-3.5 w-3.5" /> Export CSV
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setShowDelete(true)}>
                <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete Link
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* ===== TAB 1: Overview ===== */}
        <TabsContent value="overview" className="mt-0 space-y-4">
          {/* Stats bar */}
          {stats.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {stats.map((stat) => {
                const isInactive = !stat.configured && (stat.value === 0 || stat.value === '0.0%');
                return (
                  <div key={stat.label} className={`flex items-center justify-between gap-3 rounded-lg border p-3 ${isInactive ? 'opacity-40' : ''}`}>
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground truncate">{stat.label}</p>
                      {isInactive ? (
                        <p className="text-xs text-muted-foreground mt-1">Not configured</p>
                      ) : (
                        <p className="text-lg font-bold">
                          {typeof stat.value === 'number' ? stat.value.toLocaleString() : stat.value}
                        </p>
                      )}
                    </div>
                    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${isInactive ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary'}`}>
                      <stat.icon className="h-4 w-4" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Row 1: Click Trends + Link Info — same height */}
          <div className="grid gap-4 lg:grid-cols-5 items-stretch">
            <Card className="p-4 lg:col-span-3 flex flex-col overflow-hidden">
              <div className="flex items-center justify-between mb-3 shrink-0">
                <p className="text-sm font-semibold">Click Trends</p>
                <div className="flex gap-1">
                  {clickRanges.map((r, i) => (
                    <Button
                      key={r.label}
                      variant={i === clickRangeIdx ? 'default' : 'outline'}
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => setClickRangeIdx(i)}
                    >
                      {r.label}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="flex-1 min-h-[180px] h-0">
                <ClicksChart linkId={linkId!} hideFilters rangeIdx={clickRangeIdx} onRangeChange={setClickRangeIdx} />
              </div>
            </Card>

            <div className="lg:col-span-2">
              <Card>
                <CardContent className="p-5 space-y-3">
                  {/* Short URL */}
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Short URL</p>
                      <div className="flex items-center gap-1.5">
                        <Button variant="outline" size="sm" onClick={copyToClipboard} className="h-7 px-2">
                          {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setShowQr(true)} className="h-7 px-2">
                          <QrCode className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <code className="block truncate text-xs font-mono font-medium tracking-tight">{shortUrl}</code>
                  </div>
                  <Separator />
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">Destination</p>
                    <a href={link.longUrl} target="_blank" rel="noopener noreferrer" className="text-xs truncate block hover:underline">
                      {link.longUrl}
                      <ExternalLink className="inline ml-1 h-3 w-3 text-muted-foreground" />
                    </a>
                  </div>
                  <Separator />
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">Created</p>
                      <p className="text-xs">{format(new Date(link.createdAt), 'MMM d, yyyy')}</p>
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">Expires</p>
                      <p className="text-xs">{link.expiresAt ? format(new Date(link.expiresAt), 'MMM d, yyyy') : 'Never'}</p>
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">Platforms</p>
                      <div className="flex gap-1.5">
                        <Badge variant={link.iosUrl ? 'default' : 'outline'} className="text-[10px]">iOS</Badge>
                        <Badge variant={link.androidUrl ? 'default' : 'outline'} className="text-[10px]">Android</Badge>
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">Project</p>
                      <p className="text-xs">{link.project?.name || link.projectId}</p>
                    </div>
                  </div>
                  {link.tags && link.tags.length > 0 && (
                    <>
                      <Separator />
                      <div className="flex gap-1 flex-wrap">
                        {link.tags.map((tag) => (
                          <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                        ))}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Row 2: Devices — full width */}
          <Card className="p-4">
            <p className="text-sm font-semibold mb-3">Devices & Browsers</p>
            <DeviceBreakdown linkId={linkId!} />
          </Card>
        </TabsContent>

        {/* ===== TAB 2: Geography ===== */}
        <TabsContent value="geography" className="space-y-4 mt-0">
          <Card className="border-0">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Geographic Distribution</CardTitle>
              <CardDescription className="text-xs">Where your clicks are coming from</CardDescription>
            </CardHeader>
            <CardContent className="pb-0">
              <GeoTable linkId={linkId!} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ===== TAB 3: Referrers & Conversions ===== */}
        <TabsContent value="attribution" className="space-y-4 mt-0">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Referrers</CardTitle>
              <CardDescription className="text-xs">Where people are finding your link</CardDescription>
            </CardHeader>
            <CardContent>
              <ReferrerTable linkId={linkId!} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Conversion Funnel</CardTitle>
              <CardDescription className="text-xs">From click to install to conversion</CardDescription>
            </CardHeader>
            <CardContent>
              <ConversionFunnel linkId={linkId!} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ===== TAB 4: A/B Testing ===== */}
        <TabsContent value="ab" className="space-y-4 mt-0">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <div className="flex items-center gap-2">
                <FlaskConical className="h-4 w-4 text-muted-foreground" />
                <div>
                  <CardTitle className="text-base">A/B Testing</CardTitle>
                  <CardDescription className="text-xs">Split traffic between multiple destinations</CardDescription>
                </div>
              </div>
              <Button size="sm" className="h-7 text-xs" onClick={() => setShowAddVariant(true)}>
                <Plus className="mr-1 h-3 w-3" /> Add Variant
              </Button>
            </CardHeader>
            <CardContent>
              {variants && variants.length > 0 ? (
                <div className="space-y-2">
                  {variants.map((v) => (
                    <div key={v.id} className="flex items-center justify-between rounded-lg border p-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{v.name}</p>
                        <p className="text-xs text-muted-foreground truncate max-w-md">{v.longUrl}</p>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <div className="text-right text-xs">
                          <p className="font-medium">{v.weight}% traffic</p>
                          <p className="text-muted-foreground">{v.clicks} clicks</p>
                        </div>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => deleteVariant.mutate(v.id)}>
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-10">
                  <FlaskConical className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm font-medium">No variants configured</p>
                  <p className="text-xs text-muted-foreground mt-1 mb-4">Add variants to split traffic between multiple destinations</p>
                  <Button size="sm" onClick={() => setShowAddVariant(true)}>
                    <Plus className="mr-1.5 h-3.5 w-3.5" /> Add First Variant
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Add Variant dialog */}
      <Dialog open={showAddVariant} onOpenChange={setShowAddVariant}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add A/B Test Variant</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Variant Name</Label>
              <Input
                value={variantForm.name}
                onChange={(e) => setVariantForm({ ...variantForm, name: e.target.value })}
                placeholder="e.g., Variant B"
              />
            </div>
            <div className="space-y-2">
              <Label>Destination URL</Label>
              <Input
                value={variantForm.longUrl}
                onChange={(e) => setVariantForm({ ...variantForm, longUrl: e.target.value })}
                placeholder="https://example.com/page-b"
              />
            </div>
            <div className="space-y-2">
              <Label>Traffic Weight (%)</Label>
              <Input
                type="number"
                min={0}
                max={100}
                value={variantForm.weight}
                onChange={(e) => setVariantForm({ ...variantForm, weight: parseInt(e.target.value) || 0 })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddVariant(false)}>Cancel</Button>
            <Button
              onClick={async () => {
                await createVariant.mutateAsync(variantForm);
                setShowAddVariant(false);
                setVariantForm({ name: '', longUrl: '', weight: 50 });
              }}
              disabled={createVariant.isPending || !variantForm.name || !variantForm.longUrl}
            >
              {createVariant.isPending ? 'Adding...' : 'Add Variant'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* QR Code dialog */}
      <Dialog open={showQr} onOpenChange={setShowQr}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>QR Code</DialogTitle>
            <DialogDescription className="truncate">{shortUrl}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-2">
            {qrData ? (
              <>
                <img src={qrData.qrCode} alt="QR Code" className="w-52 h-52 rounded-lg" />
                <div className="flex gap-2">
                  <a href={qrData.qrCode} download={`qr-${link?.shortCode}.png`}>
                    <Button variant="outline" size="sm">
                      <Download className="mr-1.5 h-3.5 w-3.5" /> PNG
                    </Button>
                  </a>
                  <Button variant="outline" size="sm" onClick={handleDownloadSvg}>
                    <Download className="mr-1.5 h-3.5 w-3.5" /> SVG
                  </Button>
                </div>
              </>
            ) : (
              <div className="w-52 h-52 animate-pulse rounded-lg bg-muted" />
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete dialog */}
      <Dialog open={showDelete} onOpenChange={setShowDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Link</DialogTitle>
            <DialogDescription>
              This will permanently delete this link and all its analytics data.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDelete(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteLink.isPending}>
              {deleteLink.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
