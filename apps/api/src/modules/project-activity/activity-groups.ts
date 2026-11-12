import type { ProjectActivityAction, ProjectActivityGroup as SharedActivityGroup } from '@chumbaq/shared';

/**
 * The API's copy of the activity groups and the action→group map in `@chumbaq/shared`.
 *
 * A copy because the API must not import runtime values from shared: its `main` is
 * `src/index.ts`, which `node dist/main` cannot load (jest maps the path, so tests would
 * not notice). The checks below fail compilation when a group or action is added on one
 * side alone; `activity-groups.spec.ts` holds that every action is in the same group.
 */
export const ACTIVITY_GROUPS = [
  'team',
  'project',
  'api_keys',
  'channels',
  'messaging',
  'privacy',
  'activity',
  'staff',
] as const;

export type ActivityGroup = (typeof ACTIVITY_GROUPS)[number];

export const ACTIVITY_ACTION_GROUPS = Object.freeze({
  'member.invited': 'team',
  'invite.resent': 'team',
  'invite.cancelled': 'team',
  'invite.accepted': 'team',
  'member.role_changed': 'team',
  'member.removed': 'team',
  'member.left': 'team',
  'billing.transfer_offered': 'team',
  'billing.transfer_accepted': 'team',
  'billing.transfer_declined': 'team',
  'billing.transfer_cancelled': 'team',
  'project.renamed': 'project',
  'project.app_links_changed': 'project',
  'project.deleted': 'project',
  'api_key.created': 'api_keys',
  'api_key.revoked': 'api_keys',
  'channel.settings_changed': 'channels',
  'channel.provider_changed': 'channels',
  'channel.credentials_uploaded': 'channels',
  'email.ses_topic_reset': 'channels',
  'email.webhook_token_rotated': 'channels',
  'webhook.created': 'channels',
  'webhook.changed': 'channels',
  'webhook.secret_rotated': 'channels',
  'webhook.deleted': 'channels',
  'mixpanel.configured': 'channels',
  'campaign.sent': 'messaging',
  'campaign.scheduled': 'messaging',
  'campaign.cancelled': 'messaging',
  'push.sent_to_person': 'messaging',
  'cohort.push_sent': 'messaging',
  'cohort.in_app_triggered': 'messaging',
  'in_app.triggered': 'messaging',
  'journey.status_changed': 'messaging',
  'in_app_message.activated': 'messaging',
  'in_app_message.paused': 'messaging',
  'content.deleted': 'messaging',
  'link.changed': 'messaging',
  'person.erased': 'privacy',
  'person.exported': 'privacy',
  'person.consent_changed': 'privacy',
  'tracking.objection_recorded': 'privacy',
  'tracking.objection_lifted': 'privacy',
  'suppression.added': 'privacy',
  'suppression.removed': 'privacy',
  'activity.exported': 'activity',
  'staff.viewed_as': 'staff',
} as const satisfies Record<ProjectActivityAction, ActivityGroup>);

// The same sets as shared, so a name added on one side alone fails compilation here.
type SameSet<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const GROUPS_MATCH_SHARED: SameSet<ActivityGroup, SharedActivityGroup> = true;
const ACTIONS_MATCH_SHARED: SameSet<keyof typeof ACTIVITY_ACTION_GROUPS, ProjectActivityAction> = true;
void GROUPS_MATCH_SHARED;
void ACTIONS_MATCH_SHARED;

const ACTIONS = Object.keys(ACTIVITY_ACTION_GROUPS) as ProjectActivityAction[];

/** The group of a stored action. */
export function groupOf(action: ProjectActivityAction): ActivityGroup {
  return ACTIVITY_ACTION_GROUPS[action];
}

/** Every action in `group`, in the map's order. */
export function actionsInGroup(group: ActivityGroup): ProjectActivityAction[] {
  return ACTIONS.filter((action) => ACTIVITY_ACTION_GROUPS[action] === group);
}

/** Shown only to a role with the `privacy` permission. */
export const PRIVACY_ACTIONS: readonly ProjectActivityAction[] = Object.freeze(actionsInGroup('privacy'));
