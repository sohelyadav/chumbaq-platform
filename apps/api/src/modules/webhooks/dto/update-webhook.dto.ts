import { PartialType } from '@nestjs/mapped-types';
import { CreateWebhookDto } from './create-webhook.dto';

/**
 * A class, not `Partial<CreateWebhookDto>`: the validation pipe skips a body
 * typed as a plain interface, which let a PATCH set `projectId` (moving the
 * webhook into another tenant's project, where it would receive their events)
 * or overwrite the stored secret.
 */
export class UpdateWebhookDto extends PartialType(CreateWebhookDto) {}
