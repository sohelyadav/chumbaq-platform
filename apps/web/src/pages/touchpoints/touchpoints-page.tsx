import { useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { format, subDays } from 'date-fns';
import {
  GitBranch, MousePointerClick, Eye, ShoppingCart, Mail, Search, Globe,
  Smartphone, Monitor, Clock,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useJourney, useChannelSummary } from '@/hooks/use-touchpoints';

const TYPE_ICONS: Record<string, React.ElementType> = {
  click: MousePointerClick,
  view: Eye,
  conversion: ShoppingCart,
  email: Mail,
  search: Search,
  web: Globe,
  mobile: Smartphone,
  desktop: Monitor,
};

function getTypeIcon(type: string) {
  if (!type) return GitBranch;
  const lower = type.toLowerCase();
  if (lower.includes('click')) return MousePointerClick;
  if (lower.includes('view') || lower.includes('open')) return Eye;
  return TYPE_ICONS[lower] || GitBranch;
}

const DATE_RANGES = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

export default function TouchpointsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [distinctIdInput, setDistinctIdInput] = useState('');
  const [activeDistinctId, setActiveDistinctId] = useState<string | undefined>();
  const [lookbackDays, setLookbackDays] = useState(30);
  const [rangeIdx, setRangeIdx] = useState(1);
  const range = DATE_RANGES[rangeIdx];

  const { start, end } = useMemo(() => {
    const now = new Date();
    return { start: subDays(now, range.days).toISOString(), end: now.toISOString() };
  }, [range.days]);

  const { data: journey, isLoading: journeyLoading } = useJourney(
    projectId,
    activeDistinctId,
    lookbackDays
  );
  const { data: channelSummary, isLoading: channelSummaryLoading } = useChannelSummary(
    projectId,
    start,
    end
  );

  const handleSearch = () => {
    const trimmed = distinctIdInput.trim();
    if (trimmed) {
      setActiveDistinctId(trimmed);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <GitBranch className="h-7 w-7" /> Touchpoints
        </h1>
        <p className="text-muted-foreground mt-1">
          Explore user journeys and channel interactions.
        </p>
      </div>

      {/* Journey Search */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">User Journey</CardTitle>
          <CardDescription className="text-xs">
            Search by distinct ID to view a user's touchpoint timeline
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 mb-4">
            <Input
              placeholder="Enter distinct ID..."
              value={distinctIdInput}
              onChange={(e) => setDistinctIdInput(e.target.value)}
              onKeyDown={handleKeyDown}
              className="max-w-sm"
            />
            <Button onClick={handleSearch} size="sm">
              Search
            </Button>
          </div>

          {!activeDistinctId ? (
            <div className="h-40 flex items-center justify-center text-muted-foreground">
              Enter a distinct ID to view the user journey
            </div>
          ) : journeyLoading ? (
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="h-16 animate-pulse rounded bg-muted" />
              ))}
            </div>
          ) : !journey || journey.length === 0 ? (
            <div className="h-40 flex items-center justify-center text-muted-foreground">
              No touchpoints found for this user
            </div>
          ) : (
            <div className="relative space-y-0">
              {/* Timeline line */}
              <div className="absolute left-4 top-3 bottom-3 w-px bg-border" />

              {journey.map((tp, i) => {
                const Icon = getTypeIcon(tp.touchpointType);
                return (
                  <div key={tp.id || i} className="relative flex items-start gap-4 py-3">
                    {/* Timeline dot */}
                    <div className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-background">
                      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className="text-xs">{tp.touchpointType}</Badge>
                        {tp.channel && <Badge variant="secondary" className="text-xs">{tp.channel}</Badge>}
                        {tp.platform && (
                          <span className="text-xs text-muted-foreground">{tp.platform}</span>
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                        {tp.campaign && <span>Campaign: {tp.campaign}</span>}
                        {tp.utmSource && <span>utm_source: {tp.utmSource}</span>}
                        {tp.utmMedium && <span>utm_medium: {tp.utmMedium}</span>}
                      </div>
                      <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {format(new Date(tp.touchedAt), 'MMM d, yyyy HH:mm:ss')}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Channel Summary */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Channel Distribution</CardTitle>
              <CardDescription className="text-xs">
                Touchpoint volume by channel
              </CardDescription>
            </div>
            <div className="flex gap-1">
              {DATE_RANGES.map((r, i) => (
                <Button
                  key={r.label}
                  variant={i === rangeIdx ? 'default' : 'outline'}
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => setRangeIdx(i)}
                >
                  {r.label}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {channelSummaryLoading ? (
            <div className="h-48 animate-pulse rounded bg-muted" />
          ) : !channelSummary || channelSummary.length === 0 ? (
            <div className="h-40 flex items-center justify-center text-muted-foreground">
              No channel data available
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Channel</TableHead>
                  <TableHead className="text-right">Touchpoints</TableHead>
                  <TableHead className="text-right">Share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {channelSummary.map((entry) => (
                  <TableRow key={entry.channel}>
                    <TableCell className="font-medium">
                      <Badge variant="outline">{entry.channel}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {entry.count.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {entry.percentage.toFixed(1)}%
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
