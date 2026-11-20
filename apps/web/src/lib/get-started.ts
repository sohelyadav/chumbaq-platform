/**
 * The get-started checklist on a project's dashboard: what the steps are, which are
 * done, and the SDK snippets with this project's own values in them.
 *
 * Kept apart from the card and pure, like `segment-form.ts`, because what it gets wrong
 * is silent: a step shown as done that is not, or a snippet with the wrong host, sends
 * someone off to debug their own app for something this page told them.
 */

export const GET_STARTED_STEP_IDS = ['key', 'sdk', 'credentials', 'device', 'campaign'] as const;
export type GetStartedStepId = (typeof GET_STARTED_STEP_IDS)[number];

/**
 * What the project has so far. `null` means not known: still loading, the request
 * failed, or the person's role may not see it (a member cannot list API keys). It is
 * never read as zero, which would tell someone to redo what is already done.
 */
export interface GetStartedFacts {
  apiKeys: number | null;
  /** Devices the SDK has reported, with or without a push token. */
  devices: number | null;
  /** Push channels with credentials: FCM, APNs. */
  pushChannels: number | null;
  /** Devices holding a push token. */
  pushDevices: number | null;
  campaigns: number | null;
}

export interface GetStartedStep {
  id: GetStartedStepId;
  /** true: done. false: known not done. null: not known. */
  done: boolean | null;
}

const known = (count: number | null): boolean | null => (count === null ? null : count > 0);

/**
 * Whether an app can use this key: live, not expired, and not a privacy key, which the
 * API refuses on every SDK route. A project whose only key is one of those still needs
 * a key before its app can connect.
 */
export function usableBySdk(
  key: { isActive: boolean; expiresAt: string | null; permissions: string[] },
  now: number,
): boolean {
  if (!key.isActive) return false;
  if (key.permissions.includes('privacy')) return false;
  return key.expiresAt === null || new Date(key.expiresAt).getTime() > now;
}

export function getStartedSteps(facts: GetStartedFacts): GetStartedStep[] {
  // A device holding a push token is a device, and a campaign went to some device with
  // some credentials: a later fact settles an earlier one this role or request missed.
  const pushDevice = known(facts.pushDevices);
  const device = known(facts.devices);
  return [
    { id: 'key', done: known(facts.apiKeys) ?? (device === true || pushDevice === true ? true : null) },
    { id: 'sdk', done: pushDevice === true ? true : device },
    { id: 'credentials', done: known(facts.pushChannels) },
    { id: 'device', done: pushDevice },
    { id: 'campaign', done: known(facts.campaigns) },
  ];
}

/** The first step not known to be done: the one the card opens on. Null when all are. */
export function nextStep(steps: GetStartedStep[]): GetStartedStepId | null {
  return steps.find((step) => step.done !== true)?.id ?? null;
}

export function doneCount(steps: GetStartedStep[]): number {
  return steps.filter((step) => step.done === true).length;
}

/** Only when every step is known done. An unknown one keeps the card up. */
export function allDone(steps: GetStartedStep[]): boolean {
  return steps.every((step) => step.done === true);
}

/** Hidden once finished, or once the person hid it for this project in this browser. */
export function showGetStarted(steps: GetStartedStep[], dismissed: boolean): boolean {
  return !dismissed && !allDone(steps);
}

export function dismissedKey(projectId: string): string {
  return `chumbaq_get_started_hidden:${projectId}`;
}

export const SDK_PLATFORMS = ['flutter', 'ios', 'android', 'web'] as const;
export type SdkPlatform = (typeof SDK_PLATFORMS)[number];

export const SDK_PLATFORM_LABELS: Record<SdkPlatform, string> = {
  flutter: 'Flutter',
  ios: 'iOS',
  android: 'Android',
  web: 'Web',
};

export interface SdkSnippets {
  /** Where the install line goes: a terminal, or the name of a file. */
  installWhere: string;
  install: string;
  init: string;
  push: string;
  /** What the push snippet leaves to the app. */
  pushNote: string;
}

export const API_KEY_PLACEHOLDER = '<your API key>';

/**
 * The oldest SDK release the snippets ask for: the first that sends `userHash`, which the
 * API needs before it takes an external user id. One place to raise it.
 */
export const SDK_MIN_VERSION = '0.2.0';

/** The host the SDK talks to: the page's own origin, with no path and no trailing slash. */
export function sdkBaseUrl(origin: string): string {
  return origin.replace(/\/+$/, '');
}

/**
 * A value inside a quoted string in a snippet. Project ids, origins and API keys never
 * hold a quote or a backslash; anything that does is left out rather than pasted into
 * code someone will run.
 */
function literal(value: string, fallback: string): string {
  return /^[A-Za-z0-9._~:/\-[\]@]+$/.test(value) ? value : fallback;
}

/**
 * Each SDK's own calls, as its README gives them, with this project's values filled in.
 * `apiKey` is only ever the key just made on this page; otherwise a placeholder, since a
 * stored key cannot be read back.
 */
export function sdkSnippets(
  platform: SdkPlatform,
  values: { baseUrl: string; projectId: string; apiKey?: string | null },
): SdkSnippets {
  const baseUrl = literal(sdkBaseUrl(values.baseUrl), 'https://your-chumbaq-host');
  const projectId = literal(values.projectId, '<project id>');
  const apiKey = values.apiKey ? literal(values.apiKey, API_KEY_PLACEHOLDER) : API_KEY_PLACEHOLDER;

  switch (platform) {
    case 'flutter':
      return {
        installWhere: 'terminal',
        install: 'flutter pub add chumbaq',
        init: `final config = ChumbaqConfig.builder(
  baseUrl: '${baseUrl}',
  apiKey: '${apiKey}',
  projectId: '${projectId}',
).build();

await Chumbaq.instance.init(config);`,
        push: `await ChumbaqPush.instance.init();

// iOS only: APNs gives the device token to your AppDelegate, never to the
// plugin. In application(_:didRegisterForRemoteNotificationsWithDeviceToken:)
//   let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
// hand \`hex\` to Dart, then:
await ChumbaqPush.instance.registerToken(hex);`,
        pushNote:
          'On Android the plugin registers the FCM token itself. On iOS nothing is registered until your app passes the APNs token on, as above.',
      };
    case 'ios':
      return {
        installWhere: 'Package.swift',
        install: `.package(url: "https://github.com/sohelyadav/chumbaq-ios-sdk", from: "${SDK_MIN_VERSION}")`,
        init: `import ChumbaqCore

let config = ChumbaqConfig.Builder(
    baseUrl: "${baseUrl}",
    apiKey: "${apiKey}",
    projectId: "${projectId}"
).build()

Chumbaq.shared.initialize(config: config)`,
        push: `import ChumbaqPush

ChumbaqPush.shared.initialize()

// In application(_:didRegisterForRemoteNotificationsWithDeviceToken:)
try await ChumbaqPush.shared.registerToken(deviceToken)`,
        pushNote: 'iOS sends through APNs, so this project needs an Apple Push key under Push > Settings.',
      };
    case 'android':
      return {
        installWhere: 'build.gradle.kts',
        install: `dependencies {
    implementation(platform("com.chumbaq:chumbaq-bom:${SDK_MIN_VERSION}"))
    implementation("com.chumbaq:chumbaq-core")
    implementation("com.chumbaq:chumbaq-push")
}`,
        init: `val config = ChumbaqConfig.Builder(
    baseUrl = "${baseUrl}",
    apiKey = "${apiKey}",
    projectId = "${projectId}",
).build()

Chumbaq.init(context, config)`,
        push: `ChumbaqPush.init(context)`,
        pushNote: 'The SDK fetches the FCM token and registers it. Android 13 and later also need the notification permission.',
      };
    case 'web':
      return {
        installWhere: 'terminal',
        install: 'npm install @chumbaq/sdk',
        init: `import Chumbaq from '@chumbaq/sdk';

const chumbaq = new Chumbaq({
  baseUrl: '${baseUrl}',
  apiKey: '${apiKey}',
  projectId: '${projectId}',
});

await chumbaq.init();`,
        push: `// The token from your own Firebase Messaging setup.
await chumbaq.registerPushToken({
  token: fcmToken,
  platform: 'web',
  provider: 'fcm',
});`,
        pushNote: "Web push uses your Firebase project's web credentials and service worker.",
      };
  }
}
