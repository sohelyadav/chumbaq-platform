import { useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { subDays } from 'date-fns';
import { Target } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table';
import {
  SelectRoot as Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  useChannelAttribution,
  useCampaignAttribution,
  useModelComparison,
  type AttributionModel,
} from '@/hooks/use-attribution';

const MODELS: { value: AttributionModel; label: string }[] = [
  { value: 'last_touch', label: 'Last Touch' },
  { value: 'first_touch', label: 'First Touch' },
  { value: 'linear', label: 'Linear' },
  { value: 'time_decay', label: 'Time Decay' },
];

const DATE_RANGES = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

export default function AttributionDashboardPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [model, setModel] = useState<AttributionModel>('last_touch');
  const [rangeIdx, setRangeIdx] = useState(1);
  const range = DATE_RANGES[rangeIdx];

  const { start, end } = useMemo(() => {
    const now = new Date();
    return { start: subDays(now, range.days).toISOString(), end: now.toISOString() };
  }, [range.days]);

  const { data: channels, isLoading: channelsLoading } = useChannelAttribution(projectId, model, start, end);
  const { data: campaigns, isLoading: campaignsLoading } = useCampaignAttribution(projectId, model, start, end);
  const { data: comparison, isLoading: comparisonLoading } = useModelComparison(projectId, start, end);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Target className="h-7 w-7" /> Attribution
          </h1>
          <p className="text-muted-foreground mt-1">
            Understand which channels and campaigns drive conversions.
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <Select value={model} onValueChange={(v) => setModel(v as AttributionModel)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Attribution model" />
          </SelectTrigger>
          <SelectContent>
            {MODELS.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex gap-1">
          {DATE_RANGES.map((r, i) => (
            <Button
              key={r.label}
              variant={i === rangeIdx ? 'default' : 'outline'}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => setRangeIdx(i)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Channel Attribution */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Channel Attribution</CardTitle>
          <CardDescription className="text-xs">
            Credit distribution across channels using {MODELS.find((m) => m.value === model)?.label} model
          </CardDescription>
        </CardHeader>
        <CardContent>
          {channelsLoading ? (
            <div className="h-48 animate-pulse rounded bg-muted" />
          ) : !channels || channels.length === 0 ? (
            <div className="h-40 flex items-center justify-center text-muted-foreground">
              No channel attribution data
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Channel</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead className="text-right">Conversions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {channels.map((entry) => (
                  <TableRow key={entry.channel}>
                    <TableCell className="font-medium">
                      <Badge variant="outline">{entry.channel}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {(entry.credit * 100).toFixed(1)}%
                    </TableCell>
                    <TableCell className="text-right">
                      {entry.conversions.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Campaign Attribution */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Campaign Attribution</CardTitle>
          <CardDescription className="text-xs">
            Per-campaign credit and conversion breakdown
          </CardDescription>
        </CardHeader>
        <CardContent>
          {campaignsLoading ? (
            <div className="h-48 animate-pulse rounded bg-muted" />
          ) : !campaigns || campaigns.length === 0 ? (
            <div className="h-40 flex items-center justify-center text-muted-foreground">
              No campaign attribution data
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead className="text-right">Conversions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((entry) => (
                  <TableRow key={`${entry.campaign}-${entry.channel}`}>
                    <TableCell className="font-medium">{entry.campaign}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{entry.channel}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {(entry.credit * 100).toFixed(1)}%
                    </TableCell>
                    <TableCell className="text-right">
                      {entry.conversions.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Model Comparison */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Model Comparison</CardTitle>
          <CardDescription className="text-xs">
            Side-by-side credit per channel across all attribution models
          </CardDescription>
        </CardHeader>
        <CardContent>
          {comparisonLoading ? (
            <div className="h-48 animate-pulse rounded bg-muted" />
          ) : !comparison || comparison.length === 0 ? (
            <div className="h-40 flex items-center justify-center text-muted-foreground">
              No comparison data available
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Channel</TableHead>
                  <TableHead className="text-right">Last Touch</TableHead>
                  <TableHead className="text-right">First Touch</TableHead>
                  <TableHead className="text-right">Linear</TableHead>
                  <TableHead className="text-right">Time Decay</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {comparison.map((entry) => (
                  <TableRow key={entry.channel}>
                    <TableCell className="font-medium">
                      <Badge variant="outline">{entry.channel}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {(entry.last_touch * 100).toFixed(1)}%
                    </TableCell>
                    <TableCell className="text-right">
                      {(entry.first_touch * 100).toFixed(1)}%
                    </TableCell>
                    <TableCell className="text-right">
                      {(entry.linear * 100).toFixed(1)}%
                    </TableCell>
                    <TableCell className="text-right">
                      {(entry.time_decay * 100).toFixed(1)}%
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
