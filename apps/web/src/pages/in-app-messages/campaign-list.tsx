import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Plus, MessageSquare, Play, Pause, Copy, Trash2,
  Eye, MousePointer, TrendingUp, MoreVertical, Search,
  Filter, ArrowUpDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  useInAppMessages,
  useActivateMessage,
  usePauseMessage,
  useDuplicateMessage,
  useDeleteInAppMessage,
  type InAppMessage,
  type MessageStatus,
} from '@/hooks/use-in-app-messages';
import { toast } from '@/components/ui/use-toast';

const STATUS_CONFIG: Record<MessageStatus, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-yellow-100 text-yellow-800 border-yellow-300' },
  scheduled: { label: 'Scheduled', className: 'bg-blue-100 text-blue-800 border-blue-300' },
  active: { label: 'Active', className: 'bg-green-100 text-green-800 border-green-300' },
  paused: { label: 'Paused', className: 'bg-gray-100 text-gray-600 border-gray-300' },
  completed: { label: 'Completed', className: 'bg-purple-100 text-purple-800 border-purple-300' },
  archived: { label: 'Archived', className: 'bg-slate-100 text-slate-600 border-slate-300' },
};

const TYPE_LABELS: Record<string, string> = {
  modal: '💬 Modal',
  bottom_sheet: '📋 Bottom Sheet',
  banner_top: '🔔 Top Banner',
  banner_bottom: '📢 Bottom Banner',
  fullscreen: '📱 Full Screen',
};

const TRIGGER_LABELS: Record<string, string> = {
  immediate: 'Immediate (Push)',
  on_event: 'On Event',
  on_screen: 'On Screen',
  on_app_open: 'App Open',
  scheduled: 'Scheduled',
};

export default function InAppMessagesCampaignListPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<MessageStatus | undefined>(undefined);
  const [searchQuery, setSearchQuery] = useState('');

  const { data, isLoading } = useInAppMessages(projectId, statusFilter);
  const activateMutation = useActivateMessage(projectId!);
  const pauseMutation = usePauseMessage(projectId!);
  const duplicateMutation = useDuplicateMessage(projectId!);
  const deleteMutation = useDeleteInAppMessage(projectId!);

  const messages = data?.data?.filter((m) =>
    !searchQuery || m.name.toLowerCase().includes(searchQuery.toLowerCase()),
  ) ?? [];

  const handleActivate = async (id: string) => {
    try {
      await activateMutation.mutateAsync(id);
      toast({ title: 'Campaign activated' });
    } catch {
      toast({ title: 'Failed to activate', variant: 'destructive' });
    }
  };

  const handlePause = async (id: string) => {
    try {
      await pauseMutation.mutateAsync(id);
      toast({ title: 'Campaign paused' });
    } catch {
      toast({ title: 'Failed to pause', variant: 'destructive' });
    }
  };

  const handleDuplicate = async (id: string) => {
    try {
      await duplicateMutation.mutateAsync(id);
      toast({ title: 'Campaign duplicated' });
    } catch {
      toast({ title: 'Failed to duplicate', variant: 'destructive' });
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this campaign?')) return;
    try {
      await deleteMutation.mutateAsync(id);
      toast({ title: 'Campaign deleted' });
    } catch (error: any) {
      toast({ title: error?.message || 'Failed to delete', variant: 'destructive' });
    }
  };

  const statusFilters: Array<{ label: string; value: MessageStatus | undefined }> = [
    { label: 'All', value: undefined },
    { label: 'Active', value: 'active' },
    { label: 'Draft', value: 'draft' },
    { label: 'Paused', value: 'paused' },
    { label: 'Scheduled', value: 'scheduled' },
    { label: 'Completed', value: 'completed' },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">In-App Messages</h1>
          <p className="text-muted-foreground mt-1">
            Create and manage in-app messaging campaigns
          </p>
        </div>
        <Button onClick={() => navigate(`/projects/${projectId}/in-app-messages/new`)}>
          <Plus className="mr-2 h-4 w-4" /> New Campaign
        </Button>
      </div>

      {/* Stats Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Total Campaigns</p>
                <p className="text-2xl font-bold">{data?.total ?? 0}</p>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <MessageSquare className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Active</p>
                <p className="text-2xl font-bold">
                  {data?.data?.filter((m) => m.status === 'active').length ?? 0}
                </p>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100 text-green-600">
                <Play className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Total Impressions</p>
                <p className="text-2xl font-bold">
                  {(data?.data?.reduce((sum, m) => sum + m.totalImpressions, 0) ?? 0).toLocaleString()}
                </p>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 text-blue-600">
                <Eye className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Total Clicks</p>
                <p className="text-2xl font-bold">
                  {(data?.data?.reduce((sum, m) => sum + m.totalClicks, 0) ?? 0).toLocaleString()}
                </p>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-100 text-purple-600">
                <MousePointer className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search campaigns..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
        <div className="flex items-center gap-1">
          {statusFilters.map((f) => (
            <Button
              key={f.label}
              variant={statusFilter === f.value ? 'default' : 'ghost'}
              size="sm"
              className="h-8 text-xs"
              onClick={() => setStatusFilter(f.value)}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <Card>
          <CardContent className="p-6">
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded bg-muted" />
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow className="[&_th]:text-xs">
                <TableHead className="w-[280px]">Campaign</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Impressions</TableHead>
                <TableHead className="text-right">Clicks</TableHead>
                <TableHead className="text-right">CTR</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {messages.map((msg) => {
                const ctr = msg.totalImpressions > 0
                  ? ((msg.totalClicks / msg.totalImpressions) * 100).toFixed(1)
                  : '0.0';
                const statusCfg = STATUS_CONFIG[msg.status];

                return (
                  <TableRow
                    key={msg.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => navigate(`/projects/${projectId}/in-app-messages/${msg.id}`)}
                  >
                    <TableCell>
                      <div className="min-w-0">
                        <p className="font-medium truncate">{msg.name}</p>
                        <p className="text-xs text-muted-foreground truncate">{msg.title}</p>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {TYPE_LABELS[msg.messageType] || msg.messageType}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {TRIGGER_LABELS[msg.triggerType] || msg.triggerType}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={statusCfg.className}>
                        {statusCfg.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {msg.totalImpressions.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {msg.totalClicks.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {ctr}%
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={(e) => {
                            e.stopPropagation();
                            navigate(`/projects/${projectId}/in-app-messages/${msg.id}/edit`);
                          }}>
                            Edit
                          </DropdownMenuItem>
                          {msg.status === 'draft' || msg.status === 'paused' ? (
                            <DropdownMenuItem onClick={(e) => {
                              e.stopPropagation();
                              handleActivate(msg.id);
                            }}>
                              <Play className="mr-2 h-4 w-4" /> Activate
                            </DropdownMenuItem>
                          ) : msg.status === 'active' ? (
                            <DropdownMenuItem onClick={(e) => {
                              e.stopPropagation();
                              handlePause(msg.id);
                            }}>
                              <Pause className="mr-2 h-4 w-4" /> Pause
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuItem onClick={(e) => {
                            e.stopPropagation();
                            handleDuplicate(msg.id);
                          }}>
                            <Copy className="mr-2 h-4 w-4" /> Duplicate
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDelete(msg.id);
                            }}
                          >
                            <Trash2 className="mr-2 h-4 w-4" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
              {messages.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="h-32 text-center">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <MessageSquare className="h-8 w-8 opacity-50" />
                      <p>No campaigns yet</p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => navigate(`/projects/${projectId}/in-app-messages/new`)}
                      >
                        <Plus className="mr-1 h-3 w-3" /> Create your first campaign
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
