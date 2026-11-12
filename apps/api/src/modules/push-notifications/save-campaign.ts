import type { Repository } from 'typeorm';
import type { ActivityInput, ProjectActivityService } from '../project-activity/project-activity.service';
import { recordBy, type ActivityRequester } from '../project-activity/messaging-activity';
import { PushNotificationLogEntity } from './entities/push-notification-log.entity';

/** The entry a requested campaign writes, built from the saved row. */
export interface CampaignLogging {
  requester: ActivityRequester;
  entry: (saved: PushNotificationLogEntity) => Omit<ActivityInput, 'actor'>;
}

/**
 * Saves a new campaign row and, for a dashboard request, its activity entry in the
 * same transaction, so a campaign never exists (and is never enqueued, which callers
 * do only after this returns) without the entry saying who asked for it. `null` is a
 * send the platform makes itself (a journey step), which is not logged this round.
 */
export function saveCampaign(
  logRepository: Repository<PushNotificationLogEntity>,
  activity: ProjectActivityService,
  row: PushNotificationLogEntity,
  logging: CampaignLogging | null,
): Promise<PushNotificationLogEntity> {
  return logRepository.manager.transaction(async (manager) => {
    const saved = await manager.getRepository(PushNotificationLogEntity).save(row);
    if (logging) await recordBy(activity, logging.requester, logging.entry(saved), manager);
    return saved;
  });
}
