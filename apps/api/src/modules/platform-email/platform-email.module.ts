import { Module } from '@nestjs/common';
import { PlatformEmailService } from './platform-email.service';
import { SecurityNoticesService } from './security-notices.service';

@Module({
  providers: [PlatformEmailService, SecurityNoticesService],
  exports: [PlatformEmailService, SecurityNoticesService],
})
export class PlatformEmailModule {}
