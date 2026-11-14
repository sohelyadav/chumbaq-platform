import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Plus, Copy, Check, Key, Trash2, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useApiKeys, useCreateApiKey, useRevokeApiKey, useIdentitySecret, useRotateIdentitySecret } from '@/hooks/use-api-keys';
import { toast } from '@/components/ui/use-toast';
import { useCurrentProject } from '@/contexts/project-context';
import { can } from '@/lib/project-role';
import { format } from 'date-fns';

export default function ProjectApiKeysPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { project } = useCurrentProject();
  // Keys are read and made with `keys.manage`; a privacy key also needs `privacy` (owners).
  const managesKeys = can(project, 'keys.manage');
  const mayMakePrivacyKey = can(project, 'privacy');
  const { data: keys, isLoading } = useApiKeys(projectId, managesKeys);
  const createKey = useCreateApiKey(projectId!);
  const revokeKey = useRevokeApiKey(projectId!);
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  /** A server-only key for the privacy API (erase / export a person). Never the default. */
  const [privacyKey, setPrivacyKey] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleCreate = async () => {
    if (!newKeyName.trim()) return;
    try {
      const result = await createKey.mutateAsync({
        name: newKeyName,
        ...(privacyKey && mayMakePrivacyKey ? { permissions: ['privacy'] } : {}),
      });
      setCreatedKey(result.fullKey);
      setNewKeyName('');
      setPrivacyKey(false);
      toast({ title: 'API key created' });
    } catch {
      toast({ title: 'Failed to create key', variant: 'destructive' });
    }
  };

  const handleCopy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRevoke = async (id: string) => {
    try {
      await revokeKey.mutateAsync(id);
      toast({ title: 'API key revoked' });
    } catch {
      toast({ title: 'Failed to revoke key', variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">API Keys</h1>
        {managesKeys && (
          <Button onClick={() => { setShowCreate(true); setCreatedKey(null); setPrivacyKey(false); }}>
            <Plus className="mr-2 h-4 w-4" /> Create Key
          </Button>
        )}
      </div>

      {!managesKeys ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            Only owners and admins can see and manage API keys. Ask one of them for the key your app needs.
          </CardContent>
        </Card>
      ) : isLoading ? (
        <Card><CardContent className="p-6"><div className="h-20 animate-pulse rounded bg-muted" /></CardContent></Card>
      ) : (
        <div className="space-y-3">
          {keys?.map((key) => (
            <Card key={key.id}>
              <CardContent className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Key className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="font-medium">{key.name}</p>
                    <p className="text-sm text-muted-foreground font-mono">{key.prefix}...</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {key.permissions?.includes('privacy') && (
                    <Badge variant="outline" className="border-amber-500/60 text-amber-700 dark:text-amber-400">
                      Server only: privacy
                    </Badge>
                  )}
                  <Badge variant={key.isActive ? 'default' : 'secondary'}>
                    {key.isActive ? 'Active' : 'Revoked'}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {format(new Date(key.createdAt), 'MMM d, yyyy')}
                  </span>
                  {key.isActive && (
                    <Button variant="ghost" size="sm" onClick={() => handleRevoke(key.id)}>
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
          {keys?.length === 0 && (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                No API keys yet. Create one to get started.
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{createdKey ? 'API Key Created' : 'Create API Key'}</DialogTitle>
          </DialogHeader>
          {createdKey ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Copy this key now. You won't be able to see it again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 p-3 bg-muted rounded text-sm font-mono break-all">{createdKey}</code>
                <Button variant="outline" size="icon" onClick={() => handleCopy(createdKey)}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <Button onClick={() => setShowCreate(false)} className="w-full">Done</Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Key Name</Label>
                <Input
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="e.g., Production API Key"
                />
              </div>
              {mayMakePrivacyKey && (
              <div className="space-y-2 rounded-md border p-3">
                <label className="flex items-start gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-primary"
                    checked={privacyKey}
                    onChange={(e) => setPrivacyKey(e.target.checked)}
                  />
                  <span>
                    <span className="font-medium">Server-only privacy key</span>
                    <span className="block text-muted-foreground">
                      For your backend to erase or export a person's data (<span className="font-mono">/api/privacy</span>).
                    </span>
                  </span>
                </label>
                {privacyKey && (
                  <div className="flex gap-2 rounded-md bg-amber-500/10 p-2.5 text-xs text-amber-800 dark:text-amber-300">
                    <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    <p>
                      This key can delete or export any person in this project. Keep it on your servers only and
                      never put it in an app, website or SDK, where anyone could extract it. Apps and SDKs refuse
                      it, and it cannot be used for anything else: use an ordinary key for those.
                    </p>
                  </div>
                )}
              </div>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
                <Button onClick={handleCreate} disabled={createKey.isPending || !newKeyName.trim()}>
                  {createKey.isPending ? 'Creating...' : 'Create'}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <IdentitySecretCard />
    </div>
  );
}

/**
 * The identity secret. Every identify (and link-device) that names an external user id
 * needs a userHash, HMAC-SHA256 of that id under this secret, made on the app's own
 * server: the SDK key ships in every app, so without it anyone could claim to be any
 * user. Like an API key, it belongs on a server and never in an app.
 */
function IdentitySecretCard() {
  const { projectId } = useParams<{ projectId: string }>();
  const { project } = useCurrentProject();
  const allowed = can(project, 'keys.manage');
  const { data } = useIdentitySecret(projectId, allowed);
  const rotate = useRotateIdentitySecret(projectId);
  const [shown, setShown] = useState(false);
  if (!allowed) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="h-4 w-4" /> Identity verification
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          When your app identifies a signed-in user, pass a <code>userHash</code> with their external user id: an
          HMAC-SHA256 of the id, as hex, made with this secret on your server. Calls with an external id and no valid
          hash are refused. Keep this secret on your server, never in your app.
        </p>
        <div className="flex items-center gap-2">
          <Input readOnly value={shown && data ? data.secret : '•'.repeat(32)} className="font-mono" />
          <Button type="button" variant="outline" size="sm" onClick={() => setShown(!shown)}>
            {shown ? 'Hide' : 'Show'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!data}
            onClick={() => {
              if (data) void navigator.clipboard.writeText(data.secret);
              toast({ title: 'Copied' });
            }}
          >
            <Copy className="h-4 w-4" />
          </Button>
        </div>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{`// Node, on your server
const userHash = crypto.createHmac('sha256', IDENTITY_SECRET).update(userId).digest('hex');`}</pre>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={rotate.isPending}
          onClick={() => {
            if (!window.confirm('Rotate the secret? Every userHash made with the current one stops working at once.')) return;
            rotate.mutate(undefined, {
              onSuccess: () => toast({ title: 'Identity secret rotated' }),
              onError: () => toast({ title: 'Could not rotate the secret', variant: 'destructive' }),
            });
          }}
        >
          Rotate secret
        </Button>
      </CardContent>
    </Card>
  );
}
