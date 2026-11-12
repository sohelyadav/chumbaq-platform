import { IsUUID } from 'class-validator';

export class IamCohortTriggerDto {
  @IsUUID()
  messageId: string;
}
