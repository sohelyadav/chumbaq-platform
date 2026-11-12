import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateLinkDto } from './create-link.dto';

// shortCode is intentionally omitted — once a link is created its short code
// is immutable, because changing it would break any already-shared URLs.
export class UpdateLinkDto extends PartialType(
  OmitType(CreateLinkDto, ['shortCode'] as const),
) {}
