import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, ChevronDown, Circle, Copy, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/use-toast';
import { useCurrentProject } from '@/contexts/project-context';
import { useApiKeys, useCreateApiKey } from '@/hooks/use-api-keys';
import { useProjectChannels, usePushLogs } from '@/hooks/use-push-notifications';
import { useUserStats } from '@/hooks/use-users';
import { copyText } from '@/lib/clipboard';
import { can } from '@/lib/project-role';
import {
  SDK_PLATFORMS,
  SDK_PLATFORM_LABELS,
  usableBySdk,
  dismissedKey,
  doneCount,
  getStartedSteps,
  nextStep,
  sdkBaseUrl,
  sdkSnippets,
  showGetStarted,
  type GetStartedFacts,
  type GetStartedStepId,
  type SdkPlatform,
} from '@/lib/get-started';

const STEP_TITLES: Record<GetStartedStepId, string> = {
  key: 'Get your project ID and API key',
  sdk: 'Add the SDK to your app',
  credentials: 'Add your push credentials',
  device: 'Register a device for push',
  campaign: 'Send your first push',
};

/** Private mode and blocked storage both throw; the card then just cannot be hidden. */
function readHidden(projectId: string): boolean {
  try {
    return window.localStorage.getItem(dismissedKey(projectId)) === '1';
  } catch {
    return false;
  }
}

async function copy(text: string, what: string) {
  if (await copyText(text)) {
    toast({ title: `${what} copied` });
  } else {
    // A silent failure here leaves someone pasting whatever they copied last.
    toast({ title: 'Could not copy', description: 'Select the text and copy it yourself.', variant: 'destructive' });
  }
}

function Value({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 font-mono text-xs">{value}</code>
      <Button type="button" variant="ghost" size="sm" onClick={() => copy(value, label)}>
        <Copy className="mr-1 h-3.5 w-3.5" /> Copy
      </Button>
    </div>
  );
}

function Snippet({ where, code }: { where: string; code: string }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between border-b bg-muted/50 px-3 py-1.5">
        <span className="text-xs text-muted-foreground">{where}</span>
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => copy(code, 'Code')}>
          <Copy className="mr-1 h-3.5 w-3.5" /> Copy
        </Button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/**
 * The path from a new project to a first push, on the project's dashboard until it is
 * walked or hidden. Which steps are done comes from what the project already has
 * (`lib/get-started.ts`), so it is right for someone who set things up elsewhere.
 */
export function GetStartedCard({ projectId }: { projectId: string }) {
  const { project } = useCurrentProject();
  const managesKeys = can(project, 'keys.manage');
  const managesChannels = can(project, 'channels.manage');
  const keys = useApiKeys(projectId, managesKeys);
  const stats = useUserStats(projectId);
  const channels = useProjectChannels(projectId);
  const campaigns = usePushLogs(projectId);
  const createKey = useCreateApiKey(projectId);

  const [hidden, setHidden] = useState(() => readHidden(projectId));
  const [platform, setPlatform] = useState<SdkPlatform>('flutter');
  // Shown once by the API and kept only while this page is open.
  const [newKey, setNewKey] = useState<string | null>(null);
  const [chosen, setChosen] = useState<GetStartedStepId | null>(null);

  const facts: GetStartedFacts = {
    apiKeys: managesKeys && keys.data ? keys.data.filter((key) => usableBySdk(key, Date.now())).length : null,
    devices: stats.data ? stats.data.total : null,
    pushChannels: channels.data ? channels.data.configured.length : null,
    pushDevices: stats.data ? stats.data.pushEnabled : null,
    campaigns: campaigns.data ? campaigns.data.total : null,
  };
  const steps = getStartedSteps(facts);
  // A key just made is shown once and cannot be read back, so while one is held the
  // card stays, even when making it was the last step or the card was meant to hide.
  if (!newKey && !showGetStarted(steps, hidden)) return null;

  const open = chosen ?? nextStep(steps);
  const snippets = sdkSnippets(platform, { baseUrl: sdkBaseUrl(window.location.origin), projectId, apiKey: newKey });
  const pushSettings = `/projects/${projectId}/push-notifications?tab=settings`;

  const hide = () => {
    try {
      window.localStorage.setItem(dismissedKey(projectId), '1');
    } catch {
      // Hidden for this visit only.
    }
    setHidden(true);
  };

  const handleCreateKey = async () => {
    try {
      const created = await createKey.mutateAsync({ name: 'App key' });
      setNewKey(created.fullKey);
      // Making the key finishes this step, which would otherwise close it over the key.
      setChosen('key');
    } catch {
      toast({ title: 'Could not create the key', variant: 'destructive' });
    }
  };

  const platformTabs = (
    <Tabs value={platform} onValueChange={(value) => setPlatform(value as SdkPlatform)}>
      <TabsList>
        {SDK_PLATFORMS.map((p) => (
          <TabsTrigger key={p} value={p}>
            {SDK_PLATFORM_LABELS[p]}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );

  const bodies: Record<GetStartedStepId, ReactNode> = {
    key: (
      <div className="space-y-3">
        <Value label="Project ID" value={projectId} />
        <Value label="Base URL" value={sdkBaseUrl(window.location.origin)} />
        {newKey ? (
          <>
            <Value label="API key" value={newKey} />
            <p className="text-xs text-muted-foreground">
              Copy the key now. It is shown once, and it is already filled into the code in the next step.
            </p>
          </>
        ) : !managesKeys ? (
          <p className="text-sm text-muted-foreground">Ask an owner or admin of this project for an API key.</p>
        ) : facts.apiKeys ? (
          <p className="text-sm text-muted-foreground">
            This project has {facts.apiKeys === 1 ? 'an API key' : `${facts.apiKeys} API keys`}. A stored key cannot be
            shown again, so create another if you no longer have it.{' '}
            <Link to={`/projects/${projectId}/api-keys`} className="text-primary underline-offset-4 hover:underline">
              Manage keys
            </Link>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">The SDK needs an API key to talk to this project.</p>
        )}
        {managesKeys && !newKey && (
          <Button type="button" size="sm" onClick={handleCreateKey} disabled={createKey.isPending}>
            {createKey.isPending ? 'Creating…' : facts.apiKeys ? 'Create another key' : 'Create API key'}
          </Button>
        )}
      </div>
    ),
    sdk: (
      <div className="space-y-3">
        {platformTabs}
        <Snippet where={snippets.installWhere} code={snippets.install} />
        <Snippet where="At app start" code={snippets.init} />
        <p className="text-xs text-muted-foreground">
          Run the app once. This step ticks itself when the first device connects; reload the page to check.{' '}
          <a
            href={`https://chumbaq.com/docs/quick-start/${platform}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline-offset-4 hover:underline"
          >
            Full {SDK_PLATFORM_LABELS[platform]} guide
          </a>
        </p>
      </div>
    ),
    credentials: (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Android and web send through Firebase. iOS sends through Apple's push service. Add the credentials for the
          platforms you ship; they are checked before they are stored.
        </p>
        {managesChannels ? (
          <Button asChild size="sm">
            <Link to={pushSettings}>Open push settings</Link>
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">Ask an owner or admin of this project to add them.</p>
        )}
      </div>
    ),
    device: (
      <div className="space-y-3">
        {platformTabs}
        <Snippet where="After the SDK starts" code={snippets.push} />
        <p className="text-xs text-muted-foreground">
          {snippets.pushNote} This step ticks itself when a device registers its push token.
        </p>
      </div>
    ),
    campaign: (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Send one notification to your own device first, then a campaign to everyone.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <Link to={pushSettings}>Send a test push</Link>
          </Button>
          <Button asChild size="sm">
            <Link to={`/projects/${projectId}/push-notifications/new`}>Create a campaign</Link>
          </Button>
        </div>
      </div>
    ),
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1">
          <CardTitle>Send your first push</CardTitle>
          <CardDescription>
            {doneCount(steps)} of {steps.length} steps done. Each one ticks itself as your project picks it up.
          </CardDescription>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={hide} aria-label="Hide the get started steps">
          <X className="mr-1 h-4 w-4" /> Hide
        </Button>
      </CardHeader>
      <CardContent>
        <ol className="divide-y rounded-lg border">
          {steps.map((step, index) => {
            const isOpen = open === step.id;
            return (
              <li key={step.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50"
                  aria-expanded={isOpen}
                  aria-controls={isOpen ? `get-started-${step.id}` : undefined}
                  onClick={() => setChosen(isOpen ? null : step.id)}
                >
                  {step.done === true ? (
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600" aria-hidden />
                  ) : (
                    <Circle className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <span className="flex-1 text-sm font-medium">
                    {index + 1}. {STEP_TITLES[step.id]}
                    <span className="sr-only">{step.done === true ? ' (done)' : ' (not done yet)'}</span>
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`}
                    aria-hidden
                  />
                </button>
                {isOpen && (
                  <div id={`get-started-${step.id}`} className="px-4 pb-4 pl-12">
                    {bodies[step.id]}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
