import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { format } from 'date-fns';
import { Plus, Trash2, Webhook, Copy, Check, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import {
  useWebhooks,
  useCreateWebhook,
  useUpdateWebhook,
  useDeleteWebhook,
  useRotateWebhookSecret,
  type Webhook as WebhookRecord,
} from '@/hooks/use-webhooks';
import { toast } from '@/components/ui/use-toast';
import { copyText } from '@/lib/clipboard';
import { useCurrentProject } from '@/contexts/project-context';
import { can, shownValue } from '@/lib/project-role';

const EVENT_TYPES = ['click', 'conversion', 'install'];

/** The API's reason when it gave one, such as the cap on active webhooks. */
function reasonFrom(err: unknown): string | undefined {
  const message = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof message === 'string' ? message : undefined;
}

export default function ProjectWebhooksPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { project } = useCurrentProject();
  // Everyone sees the list; only `channels.manage` changes it or sees the URLs.
  const manages = can(project, 'channels.manage');
  const { data: webhooks, isLoading } = useWebhooks(projectId);
  const createWebhook = useCreateWebhook(projectId!);
  const updateWebhook = useUpdateWebhook(projectId!);
  const deleteWebhook = useDeleteWebhook(projectId!);
  const rotateSecret = useRotateWebhookSecret(projectId!);
  const [showCreate, setShowCreate] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  // Held only in this component's state: the API returns a secret once, and
  // never again, so closing the dialog is the last chance to copy it.
  const [revealed, setRevealed] = useState<{ secret: string; rotated: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState<WebhookRecord | null>(null);

  const handleCreate = async () => {
    if (!newUrl || selectedEvents.length === 0) return;
    try {
      const created = await createWebhook.mutateAsync({ url: newUrl, events: selectedEvents });
      setShowCreate(false);
      setNewUrl('');
      setSelectedEvents([]);
      setRevealed({ secret: created.secret, rotated: false });
    } catch (err) {
      toast({ title: 'Failed to create webhook', description: reasonFrom(err), variant: 'destructive' });
    }
  };

  const handleRotate = async () => {
    if (!rotating) return;
    try {
      const rotated = await rotateSecret.mutateAsync(rotating.id);
      setRotating(null);
      setRevealed({ secret: rotated.secret, rotated: true });
    } catch {
      toast({ title: 'Failed to rotate the secret', variant: 'destructive' });
    }
  };

  const handleCopy = async (text: string) => {
    if (!(await copyText(text))) {
      toast({
        title: 'Copy failed',
        description: 'Select the secret and copy it manually.',
        variant: 'destructive',
      });
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const closeRevealed = () => {
    setRevealed(null);
    setCopied(false);
  };

  const toggleEvent = (event: string) => {
    setSelectedEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Webhooks</h1>
        {manages && (
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="mr-2 h-4 w-4" /> Add Webhook
          </Button>
        )}
      </div>

      {isLoading ? (
        <Card><CardContent className="p-6"><div className="h-20 animate-pulse rounded bg-muted" /></CardContent></Card>
      ) : (
        <div className="space-y-3">
          {webhooks?.map((wh) => (
            <Card key={wh.id}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Webhook className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="font-medium font-mono text-sm">{shownValue(wh.url, project)}</p>
                      <div className="flex gap-1 mt-1">
                        {wh.events.map((e) => (
                          <Badge key={e} variant="outline" className="text-xs">{e}</Badge>
                        ))}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {wh.secretHint
                          ? <>Signing secret ending <span className="font-mono">{wh.secretHint}</span></>
                          : 'No readable signing secret. Rotate to issue one.'}
                        {' · '}
                        {wh.secretRotatedAt
                          ? `rotated ${format(new Date(wh.secretRotatedAt), 'MMM d, yyyy')}`
                          : `since ${format(new Date(wh.createdAt), 'MMM d, yyyy')}`}
                      </p>
                    </div>
                  </div>
                  {!manages ? (
                    <Badge variant={wh.isActive ? 'default' : 'secondary'}>{wh.isActive ? 'On' : 'Off'}</Badge>
                  ) : (
                  <div className="flex items-center gap-3">
                    <Button variant="outline" size="sm" onClick={() => setRotating(wh)}>
                      <RotateCw className="mr-2 h-4 w-4" /> Rotate secret
                    </Button>
                    <Switch
                      checked={wh.isActive}
                      onCheckedChange={(checked) =>
                        updateWebhook.mutate(
                          { id: wh.id, isActive: checked },
                          {
                            onError: (err) =>
                              toast({
                                title: checked ? 'Could not turn the webhook on' : 'Could not turn the webhook off',
                                description: reasonFrom(err),
                                variant: 'destructive',
                              }),
                          },
                        )
                      }
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deleteWebhook.mutate(wh.id)}
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
          {webhooks?.length === 0 && (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                No webhooks configured. Add one to receive event notifications.
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Webhook</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Endpoint URL</Label>
              <Input value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder="https://example.com/webhook" />
            </div>
            <div className="space-y-2">
              <Label>Events</Label>
              <div className="flex gap-2">
                {EVENT_TYPES.map((event) => (
                  <Badge
                    key={event}
                    variant={selectedEvents.includes(event) ? 'default' : 'outline'}
                    className="cursor-pointer"
                    onClick={() => toggleEvent(event)}
                  >
                    {event}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={createWebhook.isPending}>
              {createWebhook.isPending ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!rotating} onOpenChange={(open) => !open && setRotating(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rotate signing secret?</DialogTitle>
            <DialogDescription>
              The current secret stops working immediately. Deliveries to{' '}
              <span className="font-mono">{rotating?.url}</span> will fail verification until
              the receiver is updated with the new one.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRotating(null)}>Cancel</Button>
            <Button onClick={handleRotate} disabled={rotateSecret.isPending}>
              {rotateSecret.isPending ? 'Rotating...' : 'Rotate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!revealed} onOpenChange={(open) => !open && closeRevealed()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{revealed?.rotated ? 'New signing secret' : 'Webhook created'}</DialogTitle>
            <DialogDescription>
              Copy this signing secret now. You will not see it again: only its last four
              characters are shown after you close this. Use it to verify the
              X-Chumbaq-Signature header on each delivery.
            </DialogDescription>
          </DialogHeader>
          {revealed && (
            <div className="flex items-center gap-2">
              <code className="flex-1 p-3 bg-muted rounded text-sm font-mono break-all select-all">{revealed.secret}</code>
              <Button
                variant="outline"
                size="icon"
                aria-label="Copy signing secret"
                onClick={() => handleCopy(revealed.secret)}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          )}
          <DialogFooter>
            <Button onClick={closeRevealed} className="w-full">Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
