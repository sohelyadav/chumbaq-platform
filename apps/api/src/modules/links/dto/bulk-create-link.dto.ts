import { IsArray, ValidateNested, ArrayMaxSize } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateLinkDto } from './create-link.dto';

export class BulkCreateLinkDto {
  @IsArray()
  @ValidateNested({ each: true })
  @ArrayMaxSize(500)
  @Type(() => CreateLinkDto)
  links: CreateLinkDto[];
}
