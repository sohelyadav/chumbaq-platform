import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ProjectDomainsService } from '../../modules/projects/project-domains.service';

/** Daily, drops domain proofs whose DNS record is gone (`ProjectDomainsService.recheckAll`). */
@Injectable()
export class DomainRecheckScheduler {
  private readonly logger = new Logger(DomainRecheckScheduler.name);

  constructor(private readonly domains: ProjectDomainsService) {}

  @Cron('20 4 * * *')
  async tick(): Promise<void> {
    try {
      const dropped = await this.domains.recheckAll();
      if (dropped > 0) this.logger.log(`Dropped ${dropped} domain proof(s) whose record is gone`);
    } catch (error) {
      this.logger.error(`Domain re-check failed: ${(error as Error).message}`);
    }
  }
}
