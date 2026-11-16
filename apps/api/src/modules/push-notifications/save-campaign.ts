import type { Repository } from 'typeorm';
import type { ActivityInput, ProjectActivityService } from '../project-activity/project-activity.service';
import { recordBy, type ActivityRequester } from '../project-activity/messaging-activity';
import { PushNotificationLogEntity } from './entities/push-notification-log.entity';
import { Recipients, storeRecipients } from './recipients';

/** The entry a requested campaign writes, built from the saved row. */
export interface CampaignLogging {
  requester: ActivityRequester;
  entry: (saved: PushNotificationLogEntity) => Omit<ActivityInput, 'actor'>;
}

/**
 * Saves a new campaign row, who it is for (`recipients`, null for the whole project)
 * and, for a dashboard request, its activity entry in one transaction, so a campaign
 * never exists (and is never enqueued, which callers do only after this returns)
 * without its recipients, or without the entry saying who asked for it. `null`
 * logging is a send the platform makes itself (a journey step), which is not logged.
 */
export function saveCampaign(
  logRepository: Repository<PushNotificationLogEntity>,
  activity: ProjectActivityService,
  row: PushNotificationLogEntity,
  logging: CampaignLogging | null,
  recipients: Recipients | null,
): Promise<PushNotificationLogEntity> {
  if ((row.targetType === 'project') !== (recipients === null)) {
    // A narrowed campaign with no recipients would send to nobody, and one stored for
    // the project would ignore them: refuse rather than guess which was meant.
    throw new Error(`Campaign target ${row.targetType} does not match its recipients`);
  }
  return logRepository.manager.transaction(async (manager) => {
    const saved = await manager.getRepository(PushNotificationLogEntity).save(row);
    if (recipients) await storeRecipients(manager, saved, recipients);
    if (logging) await recordBy(activity, logging.requester, logging.entry(saved), manager);
    return saved;
  });
}
