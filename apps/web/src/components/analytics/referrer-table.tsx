import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '@/components/ui/table';
import { useLinkReferrers } from '@/hooks/use-analytics';

interface ReferrerTableProps {
  linkId: string;
}

export function ReferrerTable({ linkId }: ReferrerTableProps) {
  const { data, isLoading } = useLinkReferrers(linkId);

  if (isLoading) {
    return <div className="h-64 animate-pulse rounded bg-muted" />;
  }

  if (!data || data.length === 0) {
    return (
      <div className="h-40 flex items-center justify-center text-muted-foreground">
        No referrer data available
      </div>
    );
  }

  const total = data.reduce((sum, r) => sum + r.count, 0);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Referrer</TableHead>
          <TableHead className="text-right">Clicks</TableHead>
          <TableHead className="text-right">Share</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((entry) => (
          <TableRow key={entry.referrer}>
            <TableCell className="font-medium">
              {entry.referrer || 'Direct / Unknown'}
            </TableCell>
            <TableCell className="text-right">{entry.count.toLocaleString()}</TableCell>
            <TableCell className="text-right text-muted-foreground">
              {total > 0 ? ((entry.count / total) * 100).toFixed(1) : 0}%
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
