import type { Request } from 'express';
import type { EntityManager } from 'typeorm';
import type { ProjectActivityAction } from '@chumbaq/shared';
import { activityContext, type ActivityContext } from './activity-context';
import { campaignLabel } from '../sms/sms-label';
import type { ActivityInput, ProjectActivityService } from './project-activity.service';

/**
 * The signed-in person a dashboard request came from, and from where. Messaging
 * services take one wherever a route acts on the outside world; the journey runner
 * and other platform-initiated sends pass `null` and are not logged this round.
 */
export interface ActivityRequester {
  userId: string;
  context: ActivityContext;
}

export function requesterOf(userId: string, req: Request): ActivityRequester {
  return { userId, context: activityContext(req) };
}

/** Writes `input` as the requester, in `manager`'s transaction when given. */
export function recordBy(
  activity: ProjectActivityService,
  requester: ActivityRequester,
  input: Omit<ActivityInput, 'actor'>,
  manager?: EntityManager,
): Promise<void> {
  return activity.record({ ...input, actor: { kind: 'user', userId: requester.userId } }, requester.context, manager);
}

/** What a `content.deleted` entry names in `details.kind`, and its target type. */
export type ContentKind =
  | 'journey'
  | 'segment'
  | 'in_app_message'
  | 'banner'
  | 'banner_category'
  | 'template'
  | 'link'
  | 'cohort';

/** `content.deleted`, naming the item as it was read before the delete. */
export function contentDeleted(
  projectId: string,
  kind: ContentKind,
  item: { id: string; name: string | null | undefined },
): Omit<ActivityInput, 'actor'> {
  return {
    projectId,
    action: 'content.deleted',
    target: { type: kind, id: item.id, label: item.name ?? null },
    details: { kind },
  };
}

/** The campaign row fields an entry reads: never its audience or content. */
export interface CampaignRow {
  id: string;
  projectId: string;
  title: string | null;
  /** Read only to tell an unnamed SMS campaign, whose title is its text, from a named one. */
  body?: string | null;
  channel: 'push' | 'email' | 'sms' | 'whatsapp';
  totalTokens: number | null;
  status?: string;
}

/** What an unnamed SMS campaign is called in the log. */
export const UNNAMED_SMS_LABEL = 'SMS campaign';

/**
 * The campaign's name as the log shows it. An SMS campaign without a name is listed
 * under the start of its text, which can carry an end user's details (a code, a
 * name filled in by the sender), so the log calls it `SMS campaign` instead.
 */
function campaignLabelOf(log: CampaignRow): string | null {
  if (log.channel === 'sms' && (!log.title || log.title === campaignLabel(log.body ?? ''))) {
    return UNNAMED_SMS_LABEL;
  }
  return log.title ?? null;
}

/**
 * `campaign.sent`, `campaign.scheduled` or `campaign.cancelled` for one row. The
 * audience size is the count the send path computed and stored (tokens for push,
 * recipients for the other channels); left out when the row has none.
 */
export function campaignEntry(
  log: CampaignRow,
  action: Extract<ProjectActivityAction, 'campaign.sent' | 'campaign.scheduled' | 'campaign.cancelled'>,
): Omit<ActivityInput, 'actor'> {
  return {
    projectId: log.projectId,
    action,
    target: { type: 'campaign', id: log.id, label: campaignLabelOf(log) },
    details: {
      channel: log.channel,
      ...(typeof log.totalTokens === 'number' ? { audienceSize: log.totalTokens } : {}),
    },
  };
}

/**
 * `campaign.scheduled` for a row the send path held (a future time, a recurrence, an
 * experiment, a local-time or send-time-optimised split), `campaign.sent` for one it
 * queued now. Read from the saved row, so it is whatever the service decided.
 */
export function heldOrSent(saved: Pick<CampaignRow, 'status'>): 'campaign.scheduled' | 'campaign.sent' {
  return saved.status === 'scheduled' ? 'campaign.scheduled' : 'campaign.sent';
}
