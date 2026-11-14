import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { promises as dns } from 'dns';
import { QueryFailedError, Repository } from 'typeorm';
import { hostOf, isPlatformHost } from '../../common/platform-hosts';
import type { ActivityContext } from '../project-activity/activity-context';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { ProjectEntity } from './entities/project.entity';

/** The DNS name the proof lives at, under the project's domain. */
export const DOMAIN_TXT_PREFIX = '_chumbaq-verify';
export const DOMAIN_TXT_VALUE_PREFIX = 'chumbaq-verify=';

export function newDomainToken(): string {
  return randomBytes(16).toString('hex');
}

/** Looks up a name's TXT records; injectable so tests need no real DNS. */
export const DOMAIN_TXT_RESOLVER = Symbol('DOMAIN_TXT_RESOLVER');
export type TxtResolver = (name: string) => Promise<string[][]>;

const LOOKUP_TIMEOUT_MS = 5000;

async function resolveTxtWithTimeout(name: string): Promise<string[][]> {
  const resolver = new dns.Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: 2 });
  return resolver.resolveTxt(name);
}

/**
 * Proof that a project controls its `domain`, before the app-association files
 * (`/.well-known/...`, RedirectService) name its app for that host: anyone can type any
 * domain into a project, so an unproved one would let a tenant claim another's links.
 * The proof is a TXT record at `_chumbaq-verify.<domain>` carrying
 * `chumbaq-verify=<the project's token>`; the token is replaced, and the proof
 * dropped, whenever the domain changes. One project at most holds a proof per domain.
 */
@Injectable()
export class ProjectDomainsService {
  private readonly lookup: TxtResolver;

  constructor(
    @InjectRepository(ProjectEntity) private readonly projects: Repository<ProjectEntity>,
    private readonly activity: ProjectActivityService,
    @Optional() @Inject(DOMAIN_TXT_RESOLVER) lookup?: TxtResolver,
  ) {
    this.lookup = lookup ?? resolveTxtWithTimeout;
  }

  async verify(actorId: string, projectId: string, ctx: ActivityContext): Promise<ProjectEntity> {
    const project = await this.projects.findOne({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found');
    const domain = project.domain ?? '';
    if (!domain || hostOf(domain) !== domain) {
      throw new BadRequestException('Set the project domain to a bare host name, such as links.example.com, first.');
    }
    if (isPlatformHost(domain)) {
      throw new BadRequestException('This domain is where this platform serves its own pages, so it cannot be verified.');
    }
    if (project.domainVerifiedAt) return project;
    const token = project.domainVerificationToken ?? '';

    let records: string[][] = [];
    try {
      records = await this.lookup(`${DOMAIN_TXT_PREFIX}.${domain}`);
    } catch {
      records = [];
    }
    const proved = token !== '' && records.some((parts) => parts.join('') === `${DOMAIN_TXT_VALUE_PREFIX}${token}`);
    if (!proved) {
      throw new BadRequestException(
        `No TXT record at ${DOMAIN_TXT_PREFIX}.${domain} with the value ${DOMAIN_TXT_VALUE_PREFIX}${token}. DNS changes can take a while to appear.`,
      );
    }

    try {
      await this.projects.manager.transaction(async (manager) => {
        // Only if the domain and token are still the ones just proved: a rename meanwhile
        // has replaced the token, and must be proved afresh.
        const result = await manager.update(
          ProjectEntity,
          { id: projectId, domain, domainVerificationToken: token },
          { domainVerifiedAt: new Date() },
        );
        if (!result.affected) throw new ConflictException('The project domain changed. Verify it again.');
        await this.activity.record(
          {
            projectId,
            actor: { kind: 'user', userId: actorId },
            action: 'project.app_links_changed',
            target: { type: 'project', id: projectId, label: project.name },
            details: { fields: ['domainVerified'] },
          },
          ctx,
          manager,
        );
      });
    } catch (error) {
      if (error instanceof QueryFailedError && (error as { code?: string }).code === '23505') {
        throw new ConflictException('Another project has already verified this domain.');
      }
      throw error;
    }
    return (await this.projects.findOne({ where: { id: projectId } })) as ProjectEntity;
  }
}
