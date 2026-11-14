import { useState } from 'react';
import type { BillingInvoiceView } from '@chumbaq/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { INVOICES_PAGE_SIZE, useInvoices } from '@/hooks/use-billing';
import { formatPaise, safeProviderUrl } from '@/lib/billing-format';

const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : null;

/** Paise as rupees; another currency (never one of our prices) as its minor units and code. */
function money(paise: number, currency: string): string {
  return currency.trim() === 'INR' ? formatPaise(paise) : `${paise} ${currency} (minor units)`;
}

function period(invoice: BillingInvoiceView): string {
  const start = day(invoice.periodStart);
  const end = day(invoice.periodEnd);
  if (start && end) return `${start} to ${end}`;
  return start ?? end ?? '—';
}

/** The provider's invoice page, in a new tab; nothing for anything but an https link. */
function InvoiceLink({ url }: { url: string | null }) {
  const href = safeProviderUrl(url);
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-sm underline underline-offset-4">
      View
    </a>
  );
}

/** The account's invoices from the provider, newest first, each opening the provider's own page. */
export function InvoicesTable() {
  const [page, setPage] = useState(1);
  const { data, isLoading, isError } = useInvoices(page);

  if (isLoading) return <div className="h-24 animate-pulse rounded bg-muted" />;
  if (isError) return <p className="text-sm text-destructive">Could not load your invoices.</p>;
  if (!data || data.meta.total === 0) {
    return <p className="text-sm text-muted-foreground">No invoices yet. They appear here after your first payment.</p>;
  }
  const pages = Math.max(1, Math.ceil(data.meta.total / INVOICES_PAGE_SIZE));
  // No tax column when nothing listed carries any: untaxed prices are charged as shown.
  const showTax = data.data.some((invoice) => invoice.taxPaise > 0);

  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Invoice</TableHead>
            <TableHead>Period</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            {showTax && <TableHead className="text-right">GST</TableHead>}
            <TableHead>Status</TableHead>
            <TableHead className="sr-only">Link</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.data.map((invoice) => (
            <TableRow key={invoice.id}>
              <TableCell className="font-mono text-xs">{invoice.number ?? day(invoice.issuedAt) ?? '—'}</TableCell>
              <TableCell>{period(invoice)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(invoice.amountPaise, invoice.currency)}</TableCell>
              {showTax && (
                <TableCell className="text-right tabular-nums">{money(invoice.taxPaise, invoice.currency)}</TableCell>
              )}
              <TableCell>
                <Badge variant={invoice.status === 'paid' ? 'secondary' : 'outline'}>{invoice.status}</Badge>
              </TableCell>
              <TableCell>
                <InvoiceLink url={invoice.shortUrl} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Newer
          </Button>
          <span className="text-muted-foreground">
            Page {page} of {pages}
          </span>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Older
          </Button>
        </div>
      )}
    </div>
  );
}
