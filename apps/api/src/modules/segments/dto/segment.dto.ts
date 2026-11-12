import {
  IsString, IsOptional, IsObject, IsIn, IsInt, Min, Max, MaxLength,
} from 'class-validator';
import { SegmentNode } from '../segment-ast';

export class CreateSegmentDto {
  @IsString()
  @MaxLength(255)
  name: string;

  @IsString()
  @IsOptional()
  description?: string;

  /** Shape is enforced by validateAst, not class-validator. */
  @IsObject()
  definition: SegmentNode;

  @IsIn(['live', 'materialized'])
  @IsOptional()
  evaluationMode?: 'live' | 'materialized';

  @IsInt()
  @Min(5)
  @Max(1440)
  @IsOptional()
  refreshIntervalMinutes?: number;

  @IsIn(['draft', 'active'])
  @IsOptional()
  status?: 'draft' | 'active';
}

export class UpdateSegmentDto {
  @IsString() @MaxLength(255) @IsOptional()
  name?: string;

  @IsString() @IsOptional()
  description?: string;

  @IsObject() @IsOptional()
  definition?: SegmentNode;

  @IsIn(['live', 'materialized']) @IsOptional()
  evaluationMode?: 'live' | 'materialized';

  @IsInt() @Min(5) @Max(1440) @IsOptional()
  refreshIntervalMinutes?: number;

  @IsIn(['draft', 'active']) @IsOptional()
  status?: 'draft' | 'active';
}

export class PreviewSegmentDto {
  @IsObject()
  definition: SegmentNode;
}
