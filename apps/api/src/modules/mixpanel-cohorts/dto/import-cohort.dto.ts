import { IsNumber, IsPositive } from 'class-validator';
import { Type } from 'class-transformer';

export class ImportCohortDto {
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  mixpanelCohortId: number;
}
