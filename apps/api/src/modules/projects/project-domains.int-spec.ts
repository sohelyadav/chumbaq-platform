import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { ProjectActivityEntity } from '../project-activity/entities/project-activity.entity';
import { ProjectEntity } from './entities/project.entity';
import { ProjectDomainsService } from './project-domains.service';
import { RedirectService } from '../redirect/redirect.service';
import { LinkEntity } from '../links/entities/link.entity';
import { ProjectsService } from './projects.service';
import { AccountLimitsService } from '../billing/account-limits.service';
import { ProjectAccessService } from '../project-access/project-access.service';
import { SeatsService } from '../project-access/seats.service';

/**
 * A project's domain gets its app named in the association files only once the
 * project proves it controls the domain with a DNS TXT record, and only one project
 * can hold that proof.
 */
describe('Project domain proof (integration)', () => {
  let ds: DataSource;
  let txt: Record<string, string[][]>;
  let dnsDown = false;
  let domains: ProjectDomainsService;
  let redirect: RedirectService;
  const owner = randomUUID();
  const saved = { ...process.env };

  beforeAll(async () => {
    ds = await openIntDb();
    process.env.APP_URL = 'https://app.example.test';
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'd')`, [
      owner,
      `${owner}@domain-proof-int.test`,
    ]);
    domains = new ProjectDomainsService(
      ds.getRepository(ProjectEntity),
      new ProjectActivityService(ds.getRepository(ProjectActivityEntity), new ConfigService({})),
      async (name: string) => {
        if (dnsDown) throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
        if (!txt[name]) throw Object.assign(new Error('none'), { code: 'ENOTFOUND' });
        return txt[name];
      },
    );
    redirect = new RedirectService(
      ds.getRepository(LinkEntity),
      ds.getRepository(ProjectEntity),
      null as never,
      { isSuspended: async () => false } as never,
    );
  });

  afterAll(async () => {
    process.env = saved;
    await ds.query(`DELETE FROM users WHERE id = $1`, [owner]);
    await closeIntDb(ds);
  });

  const project = async (domain: string) => {
    const [{ id }] = await ds.query(
      `INSERT INTO projects (name, owner_id, domain, domain_verification_token, ios_team_id, ios_bundle_id)
       VALUES ('p', $1, $2, $3, 'TEAM000001', $4) RETURNING id`,
      [owner, domain, randomUUID().replace(/-/g, ''), `com.app.${randomUUID().slice(0, 6)}`],
    );
    return id as string;
  };
  const tokenOf = async (id: string) =>
    (await ds.query(`SELECT domain_verification_token AS t FROM projects WHERE id = $1`, [id]))[0].t as string;
  const ctx = { ipAddress: null, userAgent: null };

  beforeEach(() => {
    txt = {};
    dnsDown = false;
  });
  const verifiedAt = async (id: string) =>
    (await ds.query(`SELECT domain_verified_at AS v FROM projects WHERE id = $1`, [id]))[0].v;

  it('names no app for a domain until its proof is in DNS, then the prover\'s', async () => {
    const domain = `links-${randomUUID().slice(0, 8)}.acme.test`;
    const id = await project(domain);
    expect((await redirect.getAppleAppSiteAssociation(domain)).applinks.details).toEqual([]);

    await expect(domains.verify(owner, id, ctx)).rejects.toThrow(BadRequestException);
    txt[`_chumbaq-verify.${domain}`] = [[`chumbaq-verify=${await tokenOf(id)}`]];
    await domains.verify(owner, id, ctx);

    expect((await redirect.getAppleAppSiteAssociation(domain)).applinks.details).toHaveLength(1);
  });

  it('lets only one project hold the proof for a domain', async () => {
    const domain = `shared-${randomUUID().slice(0, 8)}.acme.test`;
    const first = await project(domain);
    const second = await project(domain);
    txt[`_chumbaq-verify.${domain}`] = [[`chumbaq-verify=${await tokenOf(first)}`], [`chumbaq-verify=${await tokenOf(second)}`]];

    await domains.verify(owner, first, ctx);
    await expect(domains.verify(owner, second, ctx)).rejects.toThrow(ConflictException);
  });

  it('refuses the platform\'s own host and a domain that is not a bare host name', async () => {
    await expect(domains.verify(owner, await project('app.example.test'), ctx)).rejects.toThrow(BadRequestException);
    await expect(domains.verify(owner, await project('https://acme.test/'), ctx)).rejects.toThrow(BadRequestException);
  });

  it('drops the proof, with a new token, when the domain changes', async () => {
    const domain = `moving-${randomUUID().slice(0, 8)}.acme.test`;
    const id = await project(domain);
    const token = await tokenOf(id);
    txt[`_chumbaq-verify.${domain}`] = [[`chumbaq-verify=${token}`]];
    await domains.verify(owner, id, ctx);

    const projects = new ProjectsService(
      ds.getRepository(ProjectEntity),
      new AccountLimitsService(new ConfigService({})),
      new ProjectAccessService(null as never, null as never, null as never, null as never),
      new SeatsService(ds, new AccountLimitsService(new ConfigService({}))),
      new ProjectActivityService(ds.getRepository(ProjectActivityEntity), new ConfigService({})),
    );
    const row = await ds.getRepository(ProjectEntity).findOneByOrFail({ id });
    await projects.update(owner, row, { domain: `other-${domain}` }, ctx);

    const after = await ds.getRepository(ProjectEntity).findOneByOrFail({ id });
    expect(after.domainVerifiedAt).toBeNull();
    expect(after.domainVerificationToken).not.toBe(token);
  });

  // Following review: a domain changes hands, so a proof must not outlive its record.
  it('moves the proof to a new prover once the holder\'s record is gone', async () => {
    const domain = `sold-${randomUUID().slice(0, 8)}.acme.test`;
    const seller = await project(domain);
    txt[`_chumbaq-verify.${domain}`] = [[`chumbaq-verify=${await tokenOf(seller)}`]];
    await domains.verify(owner, seller, ctx);

    const buyer = await project(domain);
    txt[`_chumbaq-verify.${domain}`] = [[`chumbaq-verify=${await tokenOf(buyer)}`]];
    await domains.verify(owner, buyer, ctx);

    expect(await verifiedAt(seller)).toBeNull();
    expect(await verifiedAt(buyer)).not.toBeNull();
  });

  it('drops a proof whose record is gone on the daily re-check, but not when DNS fails', async () => {
    const domain = `lapsed-${randomUUID().slice(0, 8)}.acme.test`;
    const id = await project(domain);
    txt[`_chumbaq-verify.${domain}`] = [[`chumbaq-verify=${await tokenOf(id)}`]];
    await domains.verify(owner, id, ctx);

    delete txt[`_chumbaq-verify.${domain}`];
    dnsDown = true;
    await domains.recheckAll();
    expect(await verifiedAt(id)).not.toBeNull();

    dnsDown = false;
    await domains.recheckAll();
    expect(await verifiedAt(id)).toBeNull();
  });
});
