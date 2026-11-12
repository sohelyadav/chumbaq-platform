import type { EntityManager } from 'typeorm';
import type { ActivityContext } from './activity-context';
import type { ProjectActivityService } from './project-activity.service';

/** The messaging channels a `channel.*` entry names in `details.channel`. */
export type ActivityChannel = 'push' | 'email' | 'sms' | 'whatsapp';

const CHANNEL_LABELS: Record<ActivityChannel, string> = {
  push: 'Push',
  email: 'Email',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
};

/** A channel's own settings (sender, quiet hours, opt-in) as the target of an entry. */
export function channelTarget(channel: ActivityChannel): { type: 'channel'; id: string; label: string } {
  return { type: 'channel', id: channel, label: CHANNEL_LABELS[channel] };
}

/**
 * A provider (Resend, Twilio, FCM) as the target of a credentials or provider entry: its
 * name only. What was stored for it never reaches the log.
 */
export function providerTarget(
  provider: string,
  label: string,
): { type: 'channel_provider'; id: string; label: string } {
  return { type: 'channel_provider', id: provider, label };
}

/**
 * The entry for connecting a provider (email, SMS, WhatsApp), written in the caller's
 * transaction: `channel.provider_changed` when campaigns now go through a different
 * provider, else `channel.credentials_uploaded` when the stored credentials changed,
 * else nothing. Field names only: `provider`, `credentials`.
 */
export async function recordProviderConnect(
  activity: ProjectActivityService,
  manager: EntityManager,
  input: {
    projectId: string;
    actorId: string;
    channel: Exclude<ActivityChannel, 'push'>;
    provider: string;
    label: string;
    providerChanged: boolean;
    credentialsChanged: boolean;
  },
  ctx: ActivityContext,
): Promise<void> {
  const { projectId, actorId, channel, provider, label, providerChanged, credentialsChanged } = input;
  if (!providerChanged && !credentialsChanged) return;
  const fields = [...(providerChanged ? ['provider'] : []), ...(credentialsChanged ? ['credentials'] : [])];
  await activity.record(
    {
      projectId,
      actor: { kind: 'user', userId: actorId },
      action: providerChanged ? 'channel.provider_changed' : 'channel.credentials_uploaded',
      target: providerTarget(provider, label),
      details: { channel, fields },
    },
    ctx,
    manager,
  );
}
