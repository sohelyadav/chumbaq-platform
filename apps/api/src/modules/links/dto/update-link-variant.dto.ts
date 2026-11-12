import { PartialType } from '@nestjs/mapped-types';
import { CreateLinkVariantDto } from './create-link-variant.dto';

/**
 * A variant edit: any of the create fields, validated the same way. A class, not a
 * `Partial<>` type, so the global ValidationPipe whitelists the body: `linkId`, `clicks`,
 * `id` or any other key is a 400, never assigned to the row.
 */
export class UpdateLinkVariantDto extends PartialType(CreateLinkVariantDto) {}
