import {
  IsString,
  IsOptional,
  IsArray,
  IsObject,
  IsIn,
  IsNumber,
  IsInt,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JourneyStep, JourneyTrigger } from '../journey-definition';
import { JourneyStatus } from '../entities/journey.entity';

/**
 * The shape of a journey over the wire.
 *
 * `trigger` and `steps` are checked structurally here and semantically by
 * `validateJourney` in the service — class-validator can say "this is an
 * object", not "this branch points at a step that exists".
 */
/**
 * One step, as it arrives over the wire.
 *
 * Every field is optional because this stands in for a union of four shapes —
 * wait, send_push, branch, exit — and class-validator cannot express "these
 * fields when type is wait, those when it is branch". What matters here is
 * that the properties are *declared at all*: the global pipe runs with
 * `enableImplicitConversion`, which coerces each element of an undeclared
 * object array into an array, so steps used to arrive as `[[], [], []]` and
 * every journey was saved with its steps destroyed.
 *
 * Which combination is actually legal is decided by `validateJourney` in the
 * service, where the cross-field rules live.
 */
export class JourneyStepDto {
  @IsString()
  type: string;

  @IsNumber()
  @IsOptional()
  durationSeconds?: number;

  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  body?: string;

  @IsString()
  @IsOptional()
  imageUrl?: string;

  @IsString()
  @IsOptional()
  deepLinkUrl?: string;

  /** send_whatsapp: the template and its values, validated by validateJourney. */
  @IsObject()
  @IsOptional()
  content?: Record<string, unknown>;

  /** send_email */
  @IsString()
  @MaxLength(255)
  @IsOptional()
  subject?: string;

  @IsString()
  @MaxLength(500_000)
  @IsOptional()
  html?: string;

  @IsString()
  @MaxLength(500_000)
  @IsOptional()
  text?: string;

  @IsString()
  @MaxLength(255)
  @IsOptional()
  preheader?: string;

  @IsString()
  @IsOptional()
  segmentId?: string;

  @IsInt()
  @IsOptional()
  ifMember?: number;

  @IsInt()
  @IsOptional()
  ifNot?: number;
}

export class CreateJourneyDto {
  @IsString()
  @MaxLength(255)
  name: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsObject()
  trigger: JourneyTrigger;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => JourneyStepDto)
  steps: JourneyStep[];
}

export class UpdateJourneyDto {
  @IsString()
  @MaxLength(255)
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsObject()
  @IsOptional()
  trigger?: JourneyTrigger;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => JourneyStepDto)
  @IsOptional()
  steps?: JourneyStep[];
}

export class SetJourneyStatusDto {
  @IsIn(['draft', 'active', 'paused', 'archived'])
  status: JourneyStatus;
}
