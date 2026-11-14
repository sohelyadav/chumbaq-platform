import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

/** How many counted days a tenant's usage series covers. */
export class AdminUsageDto {
  @Type(() => Number)
  @IsInt()
  @Min(7)
  @Max(366)
  days: number = 90;
}
