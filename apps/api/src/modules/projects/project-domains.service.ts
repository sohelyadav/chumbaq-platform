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
import { IsNull, Not, QueryFailedError, Repository } from 'typeorm';
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

    const records = (await this.recordsFor(domain)) ?? [];
    const proved = hasProof(records, token);
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
        // Another project holds the proof. A domain changes hands: if the holder's own
        // record is gone, its proof is stale, so it moves to the project proving it now.
        if (await this.takeOver(actorId, projectId, project.name, domain, token, records, ctx)) {
          return (await this.projects.findOne({ where: { id: projectId } })) as ProjectEntity;
        }
        throw new ConflictException('Another project has already verified this domain.');
      }
      throw error;
    }
    return (await this.projects.findOne({ where: { id: projectId } })) as ProjectEntity;
  }

  /**
   * Re-checks every proved domain and drops a proof whose record is gone (the domain
   * moved on, or the tenant removed it), so a proof does not outlive its evidence. A
   * lookup that fails for any reason but "no such record" changes nothing. Returns how
   * many proofs were dropped. Run daily by the worker.
   */
  async recheckAll(): Promise<number> {
    const verified = await this.projects.find({
      where: { domainVerifiedAt: Not(IsNull()) },
      select: ['id', 'name', 'domain', 'domainVerificationToken'],
    });
    let dropped = 0;
    for (const project of verified) {
      const records = await this.recordsFor(project.domain);
      if (records === null || hasProof(records, project.domainVerificationToken ?? '')) continue;
      const result = await this.projects.update(
        { id: project.id, domain: project.domain, domainVerifiedAt: Not(IsNull()) },
        { domainVerifiedAt: null },
      );
      if (result.affected) dropped++;
    }
    return dropped;
  }

  private async takeOver(
    actorId: string,
    projectId: string,
    projectName: string,
    domain: string,
    token: string,
    records: string[][],
    ctx: ActivityContext,
  ): Promise<boolean> {
    const holder = await this.projects.findOne({ where: { domain, domainVerifiedAt: Not(IsNull()) } });
    if (!holder || hasProof(records, holder.domainVerificationToken ?? '')) return false;
    try {
      await this.projects.manager.transaction(async (manager) => {
        const cleared = await manager.update(
          ProjectEntity,
          { id: holder.id, domain, domainVerificationToken: holder.domainVerificationToken ?? '' },
          { domainVerifiedAt: null },
        );
        if (!cleared.affected) throw new ConflictException('Another project has already verified this domain.');
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
            target: { type: 'project', id: projectId, label: projectName },
            details: { fields: ['domainVerified'] },
          },
          ctx,
          manager,
        );
      });
      return true;
    } catch (error) {
      if (error instanceof ConflictException) return false;
      throw error;
    }
  }

  /** The TXT records at the proof name; [] when there are none, null when DNS did not answer. */
  private async recordsFor(domain: string): Promise<string[][] | null> {
    try {
      return await this.lookup(`${DOMAIN_TXT_PREFIX}.${domain}`);
    } catch (error) {
      const code = (error as { code?: string }).code;
      return code === 'ENOTFOUND' || code === 'ENODATA' ? [] : null;
    }
  }
}

function hasProof(records: string[][], token: string): boolean {
  return token !== '' && records.some((parts) => parts.join('') === `${DOMAIN_TXT_VALUE_PREFIX}${token}`);
}
