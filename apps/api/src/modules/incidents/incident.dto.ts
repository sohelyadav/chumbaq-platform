import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';
import type { IncidentReportMethod } from '@chumbaq/shared';
import { ANNEXURE_I_IDS } from './annexure-i';

export class CreateIncidentDto {
  /** When anyone at Chumbaq noticed it or was told; defaults to now; never in the future. */
  @IsOptional()
  @IsISO8601({ strict: true })
  noticedAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  howNoticed?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsIn(ANNEXURE_I_IDS as string[], { each: true })
  // Annexure I ids (`CertInIncidentType`), held to them by @IsIn; typed as strings so the
  // DTO object-array sweep sees a primitive array.
  types!: string[];

  @IsString()
  @Length(1, 200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  summary?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  systems?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  tenantIds?: string[];

  @IsOptional()
  @IsUUID()
  alertId?: string;
}

export class ReportIncidentDto {
  @IsIn(['email', 'phone', 'fax', 'portal'])
  method!: IncidentReportMethod;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  certinReference?: string;

  /** When it was reported, if not now (reported by phone earlier, recorded later). */
  @IsOptional()
  @IsISO8601({ strict: true })
  reportedAt?: string;
}

export class IncidentNoteDto {
  @IsString()
  @Length(1, 5000)
  note!: string;
}

const blankToNull = ({ value }: { value: unknown }) => (typeof value === 'string' && !value.trim() ? null : value);

export class SecurityContactDto {
  @IsOptional() @Transform(blankToNull) @IsString() @MaxLength(300) orgName?: string | null;
  @IsOptional() @Transform(blankToNull) @IsString() @MaxLength(300) orgAddress?: string | null;
  @IsOptional() @Transform(blankToNull) @IsString() @MaxLength(300) sector?: string | null;
  @IsOptional() @Transform(blankToNull) @IsString() @MaxLength(300) pocName?: string | null;
  @IsOptional() @Transform(blankToNull) @IsString() @MaxLength(300) pocRole?: string | null;
  @IsOptional() @Transform(blankToNull) @IsEmail() @MaxLength(300) pocEmail?: string | null;
  @IsOptional() @Transform(blankToNull) @IsString() @MaxLength(300) pocPhone?: string | null;
}
