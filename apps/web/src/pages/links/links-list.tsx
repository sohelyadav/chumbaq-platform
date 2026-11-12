import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Plus, Search, Copy, Check, ExternalLink } from 'lucide-react';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '@/components/ui/table';
import { useLinks } from '@/hooks/use-links';

export default function LinksListPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [page, setPage] = useState(1);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const limit = 20;

  const tags = tagFilter ? tagFilter.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
  const { data, isLoading, error } = useLinks(
    projectId,
    search || undefined,
    tags,
    page,
    limit
  );

  const copyToClipboard = async (shortCode: string, id: string) => {
    const url = `${window.location.origin}/${shortCode}`;
    await navigator.clipboard.writeText(url);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const getStatusBadge = (link: { isActive: boolean; expiresAt: string | null }) => {
    if (!link.isActive) return <Badge variant="secondary">Inactive</Badge>;
    if (link.expiresAt && new Date(link.expiresAt) < new Date())
      return <Badge variant="destructive">Expired</Badge>;
    return <Badge variant="default">Active</Badge>;
  };

  const totalPages = data?.meta ? data.meta.totalPages : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Links</h1>
        <Button onClick={() => navigate(`/projects/${projectId}/links/new`)}>
          <Plus className="mr-2 h-4 w-4" /> Create Link
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search links..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                className="pl-9"
              />
            </div>
            <Input
              placeholder="Filter by tags (comma-separated)"
              value={tagFilter}
              onChange={(e) => {
                setTagFilter(e.target.value);
                setPage(1);
              }}
              className="sm:w-64"
            />
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Loading links...</div>
          ) : error ? (
            <div className="p-8 text-center text-destructive">Failed to load links.</div>
          ) : !data || data.data.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              No links found.{' '}
              <Link to={`/projects/${projectId}/links/new`} className="text-primary hover:underline">
                Create your first link
              </Link>
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead>Short Code</TableHead>
                    <TableHead>Clicks</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-[80px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.data.map((link) => (
                    <TableRow key={link.id} className="cursor-pointer" onClick={() => navigate(`/projects/${projectId}/links/${link.id}`)}>
                      <TableCell className="font-medium">
                        {link.title || link.shortCode}
                        {link.tags && link.tags.length > 0 && (
                          <div className="flex gap-1 mt-1">
                            {link.tags.slice(0, 3).map((tag) => (
                              <Badge key={tag} variant="outline" className="text-xs">
                                {tag}
                              </Badge>
                            ))}
                            {link.tags.length > 3 && (
                              <Badge variant="outline" className="text-xs">
                                +{link.tags.length - 3}
                              </Badge>
                            )}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <code className="text-sm font-mono">{link.shortCode}</code>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              copyToClipboard(link.shortCode, link.id);
                            }}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            {copiedId === link.id ? (
                              <Check className="h-3.5 w-3.5 text-green-600" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </div>
                      </TableCell>
                      <TableCell>{(link.clickCount ?? 0).toLocaleString()}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {format(new Date(link.createdAt), 'MMM d, yyyy')}
                      </TableCell>
                      <TableCell>{getStatusBadge(link)}</TableCell>
                      <TableCell>
                        <a
                          href={link.longUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between p-4 border-t">
                  <p className="text-sm text-muted-foreground">
                    Showing {(page - 1) * limit + 1}-{Math.min(page * limit, data.meta.total)} of{' '}
                    {data.meta.total}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page <= 1}
                      onClick={() => setPage(page - 1)}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page >= totalPages}
                      onClick={() => setPage(page + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
