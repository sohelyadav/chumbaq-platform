import { PartialType } from '@nestjs/mapped-types';
import { IsOptional, IsIn } from 'class-validator';
import { CreateInAppMessageDto } from './create-in-app-message.dto';
import { MessageStatus } from '../entities/in-app-message.entity';

export class UpdateInAppMessageDto extends PartialType(CreateInAppMessageDto) {
  @IsOptional()
  @IsIn(['draft', 'scheduled', 'active', 'paused', 'completed', 'archived'])
  status?: MessageStatus;
}
