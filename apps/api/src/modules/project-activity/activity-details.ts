import type { ProjectActivityAction } from '@chumbaq/shared';

/**
 * The only `details` keys each action may store. `ProjectActivityService.record` refuses
 * any other key, so a careless caller can't dump a DTO (and with it a secret or an end
 * user's address) into the log. An action with no details has `[]`.
 *
 * Values are the caller's job: field *names* never values for settings, and a masked
 * address (`maskAddress`) for suppressions.
 */
export const ACTIVITY_DETAIL_KEYS: Readonly<Record<ProjectActivityAction, readonly string[]>> = {
  // Team. The invitee's address is a team member's, not an end user's.
  'member.invited': ['role', 'email'],
  'invite.resent': [],
  'invite.cancelled': [],
  'invite.accepted': [],
  'member.role_changed': ['from', 'to'],
  'member.removed': [],
  'member.left': [],
  'billing.transfer_offered': ['toUserId'],
  'billing.transfer_accepted': ['toUserId'],
  'billing.transfer_declined': ['toUserId'],
  'billing.transfer_cancelled': ['toUserId'],
  // Project
  'project.renamed': ['from', 'to'],
  'project.app_links_changed': ['fields'],
  'project.deleted': [],
  // API keys: never the key or more of its prefix than the keys page shows.
  'api_key.created': ['name', 'permissions'],
  'api_key.revoked': [],
  // Channels: changed field names only. Webhook URLs are never stored, not even the host.
  'channel.settings_changed': ['channel', 'fields'],
  'channel.provider_changed': ['channel', 'fields'],
  'channel.credentials_uploaded': ['channel', 'fields'],
  'email.ses_topic_reset': [],
  'email.webhook_token_rotated': [],
  'webhook.created': ['events', 'fields'],
  'webhook.changed': ['events', 'fields'],
  'webhook.secret_rotated': [],
  'webhook.deleted': [],
  'mixpanel.configured': [],
  // Messaging
  'campaign.sent': ['channel', 'audienceSize'],
  'campaign.scheduled': ['channel', 'audienceSize'],
  'campaign.cancelled': ['channel', 'audienceSize'],
  'push.sent_to_person': [],
  'cohort.push_sent': [],
  'cohort.in_app_triggered': [],
  'in_app.triggered': [],
  'journey.status_changed': ['from', 'to'],
  'in_app_message.activated': [],
  'in_app_message.paused': ['to'],
  'content.deleted': ['kind'],
  // Field names only, never a URL or value; `variant` is the A/B variant's name or id,
  // and `change` (added, changed, removed) says what happened to it.
  'link.changed': ['fields', 'variant', 'change'],
  // Privacy: people by internal id only; addresses masked.
  'person.erased': [],
  'person.exported': [],
  'person.consent_changed': ['consents'],
  'tracking.objection_recorded': [],
  'tracking.objection_lifted': [],
  'suppression.added': ['channel', 'address'],
  'suppression.removed': ['channel', 'address'],
  // Activity
  'activity.exported': ['filters', 'rows'],
  // Staff: no name, email, id or reason.
  'staff.viewed_as': [],
};
