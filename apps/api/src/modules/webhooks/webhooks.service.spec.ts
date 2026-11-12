import { ProjectSuspensionService } from '../projects/project-suspension.service';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { WebhooksService, toWebhookView } from './webhooks.service';
import { WebhookEntity } from './entities/webhook.entity';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';
import { openWebhookSecret, sealWebhookSecret } from './webhook-secret';

// dns/promises is used for SSRF lookups: every Resolver the code makes is
// this one stub, so a test decides what A and AAAA answer, or that nothing does.
jest.mock('dns/promises', () => {
  const resolver = { resolve4: jest.fn(), resolve6: jest.fn() };
  return { Resolver: jest.fn(() => resolver), resolverStub: resolver };
});
import * as net from 'net';

// The transport is tested on real sockets in webhook-delivery.spec.ts; here it
// only records what the service asked it to send, and to which vetted target.
jest.mock('./webhook-delivery', () => ({ postToVettedTarget: jest.fn() }));
import { postToVettedTarget } from './webhook-delivery';
import {
  DeliveryReport,
  InFlightDeliveries,
  Tally,
  MAX_IN_FLIGHT_WEBHOOKS,
  MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT,
  MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT,
  WEBHOOK_DROP_LOG_INTERVAL_MS,
  MAX_WEBHOOKS_PER_PROJECT,
  WEBHOOK_EVENT_DEADLINE_MS,
  WEBHOOK_MIN_DELIVERY_MS,
  WEBHOOK_TIMEOUT_MS,
  clickShareOf,
} from './webhooks.service';
import {
  EndpointCooldown,
  WEBHOOK_COOLDOWN_MAX_MS,
  WEBHOOK_COOLDOWN_START_MS,
  WEBHOOK_SLOW_RESPONSE_MS,
} from './webhook-cooldown';
import { WEBHOOK_DNS_CACHE_MS, WEBHOOK_MIN_DNS_BUDGET_MS, WebhookDnsCache } from './webhook-address';
import { Logger } from '@nestjs/common';
import { ProjectActivityService } from '../project-activity/project-activity.service';
const mockedPost = postToVettedTarget as jest.MockedFunction<typeof postToVettedTarget>;

const credentialsCrypto = new CredentialsCryptoService({
  get: (key: string) => (key === 'CREDENTIALS_ENCRYPTION_KEY' ? 'b2'.repeat(32) : undefined),
} as unknown as ConfigService);
const sealed = (secret: string) => sealWebhookSecret(credentialsCrypto, secret);
const ACTOR = 'user-1';
const CTX = { ipAddress: null, userAgent: null };

describe('WebhooksService', () => {
  let service: WebhooksService;

  const mockWebhookRepo = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    delete: jest.fn(async () => ({ affected: 1 })),
    count: jest.fn(async () => 0),
    // The cap check runs in a transaction; the lock it takes is the
    // integration spec's to prove, so here it only routes back to this mock.
    manager: {
      transaction: jest.fn(async (work: (m: unknown) => unknown) =>
        work({ query: jest.fn(), getRepository: () => mockWebhookRepo }),
      ),
    },
  };

  /**
   * One stored row behind findOne and update, so a test sees what was written
   * rather than what the service chose to return.
   */
  const storeRow = (initial: Record<string, any>) => {
    const row = { ...initial };
    mockWebhookRepo.findOne.mockImplementation(async ({ where }) =>
      where.id === row.id && where.projectId === row.projectId ? { ...row } : null,
    );
    mockWebhookRepo.update.mockImplementation(async (_criteria, patch) => {
      Object.assign(row, patch);
      return { affected: 1 };
    });
    return row;
  };

  const resolver = (jest.requireMock('dns/promises') as any).resolverStub as {
    resolve4: jest.Mock;
    resolve6: jest.Mock;
  };
  const noData = () => Promise.reject(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));
  /** DNS answers every name with these addresses, split into A and AAAA. */
  const dnsAnswers = (...addresses: string[]) => {
    const v4 = addresses.filter((a) => net.isIPv4(a));
    const v6 = addresses.filter((a) => net.isIPv6(a));
    resolver.resolve4.mockImplementation(() => (v4.length ? Promise.resolve(v4) : noData()));
    resolver.resolve6.mockImplementation(() => (v6.length ? Promise.resolve(v6) : noData()));
  };
  /** A nameserver that drops every query. */
  const dnsNeverAnswers = () => {
    resolver.resolve4.mockImplementation(() => new Promise(() => undefined));
    resolver.resolve6.mockImplementation(() => new Promise(() => undefined));
  };
  const askedDns = () => resolver.resolve4.mock.calls.length;

  const activity = { record: jest.fn() };

  let suspendedProject: string | null = null;
  const suspension = {
    isSuspended: jest.fn(async (id: string) => id === suspendedProject),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    suspendedProject = null;
    // By default, DNS resolves to a public IP so SSRF guard passes.
    resolver.resolve4.mockReset();
    resolver.resolve6.mockReset();
    dnsAnswers('93.184.216.34');
    mockedPost.mockReset();
    mockedPost.mockResolvedValue({ status: 200 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: getRepositoryToken(WebhookEntity), useValue: mockWebhookRepo },
        { provide: ProjectSuspensionService, useValue: suspension },
        { provide: CredentialsCryptoService, useValue: credentialsCrypto },
        { provide: ProjectActivityService, useValue: activity },
      ],
    }).compile();

    service = module.get<WebhooksService>(WebhooksService);
  });

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------
  describe('create', () => {
    it('creates a webhook with a generated secret', async () => {
      mockWebhookRepo.create.mockImplementation((v) => v);
      mockWebhookRepo.save.mockImplementation(async (v) => ({ id: 'w1', ...v }));

      const result = await service.create('proj-1', {
        url: 'https://example.com/hook',
        events: ['link.created'],
      } as any, ACTOR, CTX);

      expect(mockWebhookRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
          url: 'https://example.com/hook',
          events: ['link.created'],
          isActive: true,
          secretSealed: expect.any(String),
        }),
      );
      // Returned once in plaintext: 32 random bytes as hex.
      expect(result.secret).toMatch(/^[a-f0-9]{64}$/);
      expect(result).toHaveProperty('id', 'w1');
      expect(result.secretHint).toBe(result.secret.slice(-4));

      // Stored encrypted, and decrypting gives back what was returned.
      const createArg = mockWebhookRepo.create.mock.calls[0][0];
      expect(createArg.secretSealed).not.toContain(result.secret);
      expect(openWebhookSecret(credentialsCrypto, createArg.secretSealed)).toBe(result.secret);
    });

    it('honors explicit isActive=false', async () => {
      mockWebhookRepo.create.mockImplementation((v) => v);
      mockWebhookRepo.save.mockImplementation(async (v) => v);

      await service.create('proj-1', {
        url: 'https://example.com/hook',
        events: ['link.created'],
        isActive: false,
      } as any, ACTOR, CTX);

      expect(mockWebhookRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: false }),
      );
    });

    it('rejects URLs that are malformed', async () => {
      await expect(
        service.create('proj-1', { url: 'not a url', events: ['e'] } as any, ACTOR, CTX),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects non-http protocols', async () => {
      await expect(
        service.create('proj-1', { url: 'ftp://example.com/hook', events: ['e'] } as any, ACTOR, CTX),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects literal private IP URLs (SSRF guard)', async () => {
      await expect(
        service.create('proj-1', { url: 'http://192.168.1.1/hook', events: ['e'] } as any, ACTOR, CTX),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects bracketed IPv6 loopback literals without falling through to DNS', async () => {
      // Regression: Node's URL parser returns bracketed hostnames for IPv6
      // literals (e.g. '[::1]'), which net.isIP does not accept. Without
      // stripping brackets, the literal-IP short-circuit would be skipped and
      // the request would fall through to DNS — an SSRF guard bypass.
      await expect(
        service.create('proj-1', { url: 'http://[::1]/hook', events: ['e'] } as any, ACTOR, CTX),
      ).rejects.toThrow(BadRequestException);
      expect(askedDns()).toBe(0);
    });

    it('rejects bracketed IPv6 ULA literals without falling through to DNS', async () => {
      await expect(
        service.create('proj-1', { url: 'http://[fd00::1]/hook', events: ['e'] } as any, ACTOR, CTX),
      ).rejects.toThrow(BadRequestException);
      expect(askedDns()).toBe(0);
    });

    it('rejects URLs whose hostname resolves to a private address', async () => {
      dnsAnswers('10.0.0.5');

      await expect(
        service.create('proj-1', { url: 'https://internal.example.com/hook', events: ['e'] } as any, ACTOR, CTX),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects URLs whose hostname has no DNS records', async () => {
      dnsAnswers();

      await expect(
        service.create('proj-1', { url: 'https://void.example.com/hook', events: ['e'] } as any, ACTOR, CTX),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects URLs that fail DNS resolution', async () => {
      const notFound = () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' }));
      resolver.resolve4.mockImplementation(notFound);
      resolver.resolve6.mockImplementation(notFound);

      await expect(
        service.create('proj-1', { url: 'https://invalid.example.com/hook', events: ['e'] } as any, ACTOR, CTX),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects hostnames whose DNS resolves to IPv6 loopback (::1)', async () => {
      dnsAnswers('::1');

      await expect(
        service.create('proj-1', { url: 'https://localhost-alias.example.com/hook', events: ['e'] } as any, ACTOR, CTX),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects hostnames whose DNS resolves to ULA IPv6 (fc00::/7)', async () => {
      dnsAnswers('fd12:3456:789a::1');

      await expect(
        service.create('proj-1', { url: 'https://ula.example.com/hook', events: ['e'] } as any, ACTOR, CTX),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects AWS metadata service (169.254.169.254)', async () => {
      await expect(
        service.create('proj-1', { url: 'http://169.254.169.254/latest/meta-data', events: ['e'] } as any, ACTOR, CTX),
      ).rejects.toThrow(BadRequestException);
    });

    // URL rewrites these to hex-mapped IPv6 ([::ffff:7f00:1]). Were one of
    // them ever sent to DNS, the echo below would hand the literal straight
    // back, as dns.lookup did, so only the guard's own checks refuse them.
    it.each([
      'http://[::ffff:127.0.0.1]:6379/',
      'http://[::ffff:169.254.169.254]/latest/meta-data',
      'http://[::ffff:7f00:1]/',
      'http://[::127.0.0.1]/',
      'http://[64:ff9b::a9fe:a9fe]/',
      'http://[2002:7f00:1::]/',
      'http://2130706433/',
      'http://0x7f.1/',
      'http://localhost/',
      'http://api.localhost/',
    ])('rejects %s, however DNS answers', async (url) => {
      const echo = (host: string) => [host.replace(/^\[|\]$/g, '')];
      resolver.resolve4.mockImplementation(async (host: string) => echo(host));
      resolver.resolve6.mockImplementation(async (host: string) => echo(host));

      await expect(service.create('proj-1', { url, events: ['e'] } as any, ACTOR, CTX)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockWebhookRepo.save).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // findAllByProject / findOne / update / remove
  // ---------------------------------------------------------------------------
  describe('findAllByProject', () => {
    it('queries webhooks for the project ordered by createdAt desc', async () => {
      const list = [{ id: 'w1' }, { id: 'w2' }];
      mockWebhookRepo.find.mockResolvedValueOnce(list);

      const result = await service.findAllByProject('proj-1');

      expect(result).toBe(list);
      expect(mockWebhookRepo.find).toHaveBeenCalledWith({
        where: { projectId: 'proj-1' },
        order: { createdAt: 'DESC' },
      });
    });
  });

  describe('findOne', () => {
    it('returns the webhook when found within the project', async () => {
      const hook = { id: 'w1', projectId: 'proj-1' };
      mockWebhookRepo.findOne.mockResolvedValueOnce(hook);

      const result = await service.findOne('w1', 'proj-1');

      expect(result).toBe(hook);
    });

    it('throws NotFoundException when the webhook belongs to another project', async () => {
      mockWebhookRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.findOne('w1', 'proj-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('does not re-validate URL if unchanged', async () => {
      storeRow({ id: 'w1', projectId: 'proj-1', url: 'https://example.com/hook', events: ['a'] });
      resolver.resolve4.mockClear();

      await service.update('w1', 'proj-1', { events: ['a', 'b'] } as any, ACTOR, CTX);

      expect(askedDns()).toBe(0);
    });

    it('re-validates the URL when it changes', async () => {
      const row = storeRow({ id: 'w1', projectId: 'proj-1', url: 'https://example.com/hook' });

      await service.update('w1', 'proj-1', { url: 'https://other.com/hook' } as any, ACTOR, CTX);

      expect(askedDns()).toBeGreaterThan(0);
      expect(row.url).toBe('https://other.com/hook');
    });

    it('rejects the update when the new URL resolves to a private address', async () => {
      const row = storeRow({ id: 'w1', projectId: 'proj-1', url: 'https://example.com/hook' });
      dnsAnswers('127.0.0.1');

      await expect(
        service.update('w1', 'proj-1', { url: 'https://danger.com/hook' } as any, ACTOR, CTX),
      ).rejects.toThrow(BadRequestException);
      expect(row.url).toBe('https://example.com/hook');
    });

    it('writes only the columns the body names, scoped to the project', async () => {
      storeRow({ id: 'w1', projectId: 'proj-1', url: 'https://example.com/hook', events: ['a'] });

      await service.update('w1', 'proj-1', { isActive: false } as any, ACTOR, CTX);

      expect(mockWebhookRepo.save).not.toHaveBeenCalled();
      expect(mockWebhookRepo.update).toHaveBeenCalledWith(
        { id: 'w1', projectId: 'proj-1' },
        { isActive: false },
      );
    });

    it('does not undo a rotation that lands between its read and its write', async () => {
      const row = storeRow({
        id: 'w1',
        projectId: 'proj-1',
        url: 'https://example.com/hook',
        events: ['a'],
        isActive: true,
        secretSealed: sealed('old-secret'),
        secretHint: 'cret',
        secretRotatedAt: null,
      });
      // The PATCH read the row before the rotation committed, and writes after.
      const readByPatch = { ...row };
      const { secret } = await service.rotateSecret('w1', 'proj-1', ACTOR, CTX);
      mockWebhookRepo.findOne.mockImplementationOnce(async () => readByPatch);
      await service.update('w1', 'proj-1', { events: ['a', 'b'] } as any, ACTOR, CTX);

      expect(openWebhookSecret(credentialsCrypto, row.secretSealed)).toBe(secret);
      expect(row.secretHint).toBe(secret.slice(-4));
      expect(row.secretRotatedAt).toBeInstanceOf(Date);
      expect(row.events).toEqual(['a', 'b']);
    });
  });

  describe('update cannot reach other columns', () => {
    it('ignores projectId and secret even if a body carries them', async () => {
      const original = sealed('kept');
      const row = storeRow({
        id: 'w1',
        projectId: 'proj-1',
        url: 'https://example.com/hook',
        events: ['a'],
        secretSealed: original,
      });

      const saved = await service.update('w1', 'proj-1', {
        isActive: false,
        projectId: 'victim-project',
        secretSealed: 'attacker',
      } as any, ACTOR, CTX);

      expect(row.projectId).toBe('proj-1');
      expect(row.secretSealed).toBe(original);
      expect(row.isActive).toBe(false);
      expect(saved.isActive).toBe(false);
    });
  });

  describe('rotateSecret', () => {
    it('stores a new encrypted secret, returns it once, and dates the rotation', async () => {
      const row = storeRow({
        id: 'w1',
        projectId: 'proj-1',
        url: 'https://example.com/hook',
        events: ['a'],
        secretSealed: sealed('old-secret'),
        secretHint: 'cret',
        secretRotatedAt: null,
      });

      const result = await service.rotateSecret('w1', 'proj-1', ACTOR, CTX);

      expect(result.secret).toMatch(/^[a-f0-9]{64}$/);
      expect(result.secretHint).toBe(result.secret.slice(-4));
      expect(result.secretRotatedAt).toBeInstanceOf(Date);
      expect(openWebhookSecret(credentialsCrypto, row.secretSealed)).toBe(result.secret);
    });

    it('writes only the secret columns, so a concurrent edit is not reverted', async () => {
      storeRow({ id: 'w1', projectId: 'proj-1', url: 'https://example.com/hook', events: ['a'] });

      await service.rotateSecret('w1', 'proj-1', ACTOR, CTX);

      expect(mockWebhookRepo.save).not.toHaveBeenCalled();
      const [criteria, patch] = mockWebhookRepo.update.mock.calls[0];
      expect(criteria).toEqual({ id: 'w1', projectId: 'proj-1' });
      expect(Object.keys(patch).sort()).toEqual(['secretHint', 'secretRotatedAt', 'secretSealed']);
    });

    it('is scoped to the project', async () => {
      mockWebhookRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.rotateSecret('w1', 'proj-2', ACTOR, CTX)).rejects.toThrow(NotFoundException);
      expect(mockWebhookRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('toWebhookView', () => {
    it('carries no secret material', () => {
      const view = toWebhookView({
        id: 'w1',
        projectId: 'proj-1',
        url: 'https://example.com/hook',
        events: ['a'],
        isActive: true,
        secretSealed: sealed('never-shown'),
        secretHint: 'hown',
        secretRotatedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as WebhookEntity);

      expect(Object.keys(view).sort()).toEqual(
        ['createdAt', 'events', 'id', 'isActive', 'projectId', 'secretHint', 'secretRotatedAt', 'updatedAt', 'url'],
      );
    });
  });

  describe('remove', () => {
    it('removes the webhook entity', async () => {
      const hook = { id: 'w1', projectId: 'proj-1' };
      mockWebhookRepo.findOne.mockResolvedValueOnce(hook);

      await service.remove('w1', 'proj-1', ACTOR, CTX);

      expect(mockWebhookRepo.delete).toHaveBeenCalledWith({ id: 'w1', projectId: 'proj-1' });
    });

    it('throws NotFoundException when a racing delete removed it first', async () => {
      mockWebhookRepo.findOne.mockResolvedValueOnce({ id: 'w1', projectId: 'proj-1' });
      mockWebhookRepo.delete.mockResolvedValueOnce({ affected: 0 });

      await expect(service.remove('w1', 'proj-1', ACTOR, CTX)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when removing a webhook that does not exist', async () => {
      mockWebhookRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.remove('w1', 'proj-1', ACTOR, CTX)).rejects.toThrow(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------------
  // fireWebhook — signing, filtering, error handling
  // ---------------------------------------------------------------------------
  describe('fireWebhook', () => {
    it('sends the payload to subscribers of the event with the correct headers', async () => {
      const hook = {
        id: 'w1',
        projectId: 'proj-1',
        url: 'https://example.com/hook',
        events: ['link.created'],
        secretSealed: sealed('super-secret'),
        isActive: true,
      };
      mockWebhookRepo.find.mockResolvedValueOnce([hook]);
      const deliverMock = mockedPost.mockResolvedValue({ status: 200 });

      await service.fireWebhook('proj-1', 'link.created', { linkId: 'l1' });

      expect(deliverMock).toHaveBeenCalledTimes(1);
      const [target, init] = deliverMock.mock.calls[0];
      expect(target.url.href).toBe('https://example.com/hook');
      expect(target.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(init.headers['X-Chumbaq-Signature']).toMatch(/^[a-f0-9]{64}$/);
      expect(init.headers['X-Chumbaq-Timestamp']).toMatch(/^\d+$/);

      const body = JSON.parse(init.body);
      expect(body.event).toBe('link.created');
      expect(body.data).toEqual({ linkId: 'l1' });
    });

    it('generates a signature matching HMAC-SHA256(secret, "<timestamp>.<body>")', async () => {
      const hook = {
        id: 'w1',
        projectId: 'proj-1',
        url: 'https://example.com/hook',
        events: ['link.created'],
        secretSealed: sealed('test-secret'),
        isActive: true,
      };
      mockWebhookRepo.find.mockResolvedValueOnce([hook]);
      const deliverMock = mockedPost.mockResolvedValue({ status: 200 });

      await service.fireWebhook('proj-1', 'link.created', { k: 'v' });

      const init = deliverMock.mock.calls[0][1];
      const timestamp = init.headers['X-Chumbaq-Timestamp'];
      const body = init.body;
      const expectedSignature = crypto
        .createHmac('sha256', 'test-secret')
        .update(`${timestamp}.${body}`)
        .digest('hex');
      expect(init.headers['X-Chumbaq-Signature']).toBe(expectedSignature);
    });

    it('refuses to sign with a secret left unencrypted', async () => {
      mockWebhookRepo.find.mockResolvedValueOnce([
        {
          id: 'w1',
          projectId: 'proj-1',
          url: 'https://example.com/hook',
          events: ['link.created'],
          secretSealed: 'a'.repeat(64),
          isActive: true,
        },
      ]);
      const deliverMock = mockedPost.mockResolvedValue({ status: 200 });
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

      await service.fireWebhook('proj-1', 'link.created', {});

      expect(deliverMock).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unencrypted'));
    });

    it('only fires webhooks that subscribed to the specific event', async () => {
      mockWebhookRepo.find.mockResolvedValueOnce([
        {
          id: 'w1',
          projectId: 'proj-1',
          url: 'https://example.com/hook1',
          events: ['link.created'],
          secretSealed: sealed('s1'),
          isActive: true,
        },
        {
          id: 'w2',
          projectId: 'proj-1',
          url: 'https://example.com/hook2',
          events: ['conversion.created'],
          secretSealed: sealed('s2'),
          isActive: true,
        },
      ]);
      const deliverMock = mockedPost.mockResolvedValue({ status: 200 });

      await service.fireWebhook('proj-1', 'link.created', {});

      expect(deliverMock).toHaveBeenCalledTimes(1);
      expect(deliverMock.mock.calls[0][0].url.href).toBe('https://example.com/hook1');
    });

    it('only queries active webhooks', async () => {
      mockWebhookRepo.find.mockResolvedValueOnce([]);

      await service.fireWebhook('proj-1', 'link.created', {});

      expect(mockWebhookRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { projectId: 'proj-1', isActive: true } }),
      );
    });

    it('swallows fetch failures and logs a warning', async () => {
      const hook = {
        id: 'w1',
        projectId: 'proj-1',
        url: 'https://example.com/hook',
        events: ['link.created'],
        secretSealed: sealed('s1'),
        isActive: true,
      };
      mockWebhookRepo.find.mockResolvedValueOnce([hook]);
      mockedPost.mockRejectedValue(new Error('ECONNREFUSED'));
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

      await expect(
        service.fireWebhook('proj-1', 'link.created', {}),
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/1 failed .*webhook w1: "Error: ECONNREFUSED"/));
    });

    it('does not send when the pre-send re-validation fails (DNS rebinding defense)', async () => {
      const hook = {
        id: 'w1',
        projectId: 'proj-1',
        url: 'https://rebind.example.com/hook',
        events: ['link.created'],
        secretSealed: sealed('s1'),
        isActive: true,
      };
      mockWebhookRepo.find.mockResolvedValueOnce([hook]);
      // Pretend DNS now points at a private address
      dnsAnswers('10.0.0.1');
      const deliverMock = mockedPost.mockResolvedValue({ status: 200 });
      jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

      await service.fireWebhook('proj-1', 'link.created', {});

      expect(deliverMock).not.toHaveBeenCalled();
    });

    it('resolves once and sends to that answer, not to a later one (DNS rebinding)', async () => {
      mockWebhookRepo.find.mockResolvedValueOnce([
        {
          id: 'w1',
          projectId: 'proj-1',
          url: 'https://rebind.example.com/hook',
          events: ['link.created'],
          secretSealed: sealed('s1'),
          isActive: true,
        },
      ]);
      // A TTL-0 domain: public for the check, loopback for anyone who asks again.
      resolver.resolve4
        .mockResolvedValueOnce(['93.184.216.34'])
        .mockResolvedValue(['127.0.0.1']);

      await service.fireWebhook('proj-1', 'link.created', {});

      expect(resolver.resolve4).toHaveBeenCalledTimes(1);
      expect(mockedPost).toHaveBeenCalledTimes(1);
      expect(mockedPost.mock.calls[0][0].addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
    });

    it('iterates multiple subscribers and continues after one failure', async () => {
      mockWebhookRepo.find.mockResolvedValueOnce([
        {
          id: 'w1',
          projectId: 'proj-1',
          url: 'https://ok.example.com/hook',
          events: ['link.created'],
          secretSealed: sealed('s1'),
          isActive: true,
        },
        {
          id: 'w2',
          projectId: 'proj-1',
          url: 'https://broken.example.com/hook',
          events: ['link.created'],
          secretSealed: sealed('s2'),
          isActive: true,
        },
      ]);
      const deliverMock = mockedPost
        .mockResolvedValueOnce({ status: 200 })
        .mockRejectedValueOnce(new Error('boom'));
      jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

      await service.fireWebhook('proj-1', 'link.created', {});

      expect(deliverMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('fireWebhook for a suspended tenant', () => {
    const hook = {
      id: 'w1',
      projectId: 'proj-1',
      url: 'https://example.com/hook',
      events: ['conversion'],
      secretSealed: sealed('super-secret'),
      isActive: true,
    };

    it('sends nothing to the tenant\'s endpoint', async () => {
      suspendedProject = 'proj-1';
      mockWebhookRepo.find.mockResolvedValueOnce([hook]);
      const deliverMock = mockedPost.mockResolvedValue({ status: 200 });

      await service.fireWebhook('proj-1', 'conversion', { linkId: 'l1' });

      expect(deliverMock).not.toHaveBeenCalled();
    });

    it('still sends for an active tenant', async () => {
      suspendedProject = 'other';
      mockWebhookRepo.find.mockResolvedValueOnce([hook]);
      const deliverMock = mockedPost.mockResolvedValue({ status: 200 });

      await service.fireWebhook('proj-1', 'conversion', { linkId: 'l1' });

      expect(deliverMock).toHaveBeenCalledTimes(1);
    });
  });
  // Every click and conversion fires webhooks without waiting for them, so
  // nothing upstream limits how many are in flight. A tenant whose endpoint
  // or nameserver stalls must not be able to pile them up without end, nor
  // take the slots other tenants' deliveries need.
  describe('fireWebhook under load', () => {
    /** Each project is its own account unless a test says otherwise. */
    const hookFor = (projectId: string, ownerId = `owner-${projectId}`) => ({
      id: `w-${projectId}`,
      projectId,
      project: { id: projectId, ownerId },
      url: `https://${projectId}.example.com/hook`,
      events: ['click', 'conversion'],
      secretSealed: sealed('s1'),
      isActive: true,
    });
    /** Lets fireWebhook get past its awaits up to the delivery. */
    const settle = async () => {
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    };
    /** Deliveries that stay in flight until the test lets them finish. */
    const holdDeliveries = () => {
      const pending: { resolve: () => void; reject: (e: Error) => void }[] = [];
      mockedPost.mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            pending.push({ resolve: () => resolve({ status: 200 }), reject });
          }),
      );
      return pending;
    };
    const fire = (projectId: string, event: 'click' | 'conversion' = 'conversion', ownerId?: string) => {
      mockWebhookRepo.find.mockResolvedValueOnce([hookFor(projectId, ownerId)]);
      return service.fireWebhook(projectId, event, {});
    };
    /** `count` deliveries spread over projects of one account, at most `perProject` each. */
    const fireForAccount = (ownerId: string, count: number, perProject: number) =>
      Array.from({ length: count }, (_, i) =>
        fire(`${ownerId}-p${Math.floor(i / perProject)}`, 'conversion', ownerId),
      );
    const dropWarnings = () =>
      warnSpy.mock.calls.map(([m]) => String(m)).filter((m) => m.includes(' dropped ('));

    let warnSpy: jest.SpyInstance;
    beforeEach(() => {
      warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
    });
    afterEach(() => jest.useRealTimers());

    it('loads each webhook with its project, so the account costs no extra query', async () => {
      mockWebhookRepo.find.mockResolvedValueOnce([]);
      await service.fireWebhook('proj-1', 'click', {});
      expect(mockWebhookRepo.find).toHaveBeenCalledWith({
        where: { projectId: 'proj-1', isActive: true },
        relations: { project: true },
        order: { createdAt: 'ASC', id: 'ASC' },
        take: MAX_WEBHOOKS_PER_PROJECT + 1,
      });
    });

    it('drops a project\'s delivery beyond its cap, and takes the next once one finishes', async () => {
      const pending = holdDeliveries();
      const running = Array.from({ length: MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT }, () => fire('busy'));
      await settle();
      expect(mockedPost).toHaveBeenCalledTimes(MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT);

      await fire('busy');
      expect(mockedPost).toHaveBeenCalledTimes(MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT);
      expect(dropWarnings()).toEqual([expect.stringContaining('project busy')]);

      // Another project is not held up by this one.
      const other = fire('quiet');
      await settle();
      expect(mockedPost).toHaveBeenCalledTimes(MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT + 1);

      pending[0].resolve();
      pending[1].reject(new Error('ECONNRESET'));
      await settle();
      const again = [fire('busy'), fire('busy')];
      await settle();
      expect(mockedPost).toHaveBeenCalledTimes(MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT + 3);

      pending.forEach((p) => p.resolve());
      await Promise.all([...running, other, ...again]);
    });

    it('holds one account to its cap however many projects it spreads over', async () => {
      const pending = holdDeliveries();
      // Several projects, none of them at its own cap.
      const perProject = MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT / 2;
      const running = fireForAccount('greedy', MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT, perProject);
      await settle();
      expect(mockedPost).toHaveBeenCalledTimes(MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT);

      // A fresh project of the same account still counts against it.
      await fire('greedy-fresh', 'conversion', 'greedy');
      expect(mockedPost).toHaveBeenCalledTimes(MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT);
      expect(dropWarnings()).toEqual([expect.stringContaining('its account')]);

      // Another account is not held up by this one.
      const other = fire('neighbour');
      await settle();
      expect(mockedPost).toHaveBeenCalledTimes(MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT + 1);
      expect(mockedPost.mock.calls.at(-1)![0].url.hostname).toBe('neighbour.example.com');

      pending.forEach((p) => p.resolve());
      await Promise.all([...running, other]);
    });

    it('gives another account a slot while many accounts are saturated', async () => {
      const pending = holdDeliveries();
      // As many stalled accounts as the server pool holds, less one account's worth.
      const stalled = MAX_IN_FLIGHT_WEBHOOKS / MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT - 1;
      const running = Array.from({ length: stalled }, (_, a) =>
        fireForAccount(`stalled${a}`, MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT, MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT),
      ).flat();
      await settle();
      expect(mockedPost).toHaveBeenCalledTimes(stalled * MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT);

      const other = fire('neighbour');
      await settle();
      expect(mockedPost).toHaveBeenCalledTimes(stalled * MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT + 1);

      pending.forEach((p) => p.resolve());
      await Promise.all([...running, other]);
    });

    it('frees an account\'s slots on success, on failure and on timeout', async () => {
      const pending = holdDeliveries();
      const perProject = MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT / 2;
      const running = fireForAccount('acct', MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT, perProject);
      await settle();
      await fire('acct-new', 'conversion', 'acct');
      expect(mockedPost).toHaveBeenCalledTimes(MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT);

      pending[0].resolve();
      await settle();
      const afterSuccess = fire('acct-new', 'conversion', 'acct');
      await settle();
      expect(mockedPost).toHaveBeenCalledTimes(MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT + 1);

      pending[1].reject(new Error('ECONNRESET'));
      await settle();
      const afterFailure = fire('acct-new', 'conversion', 'acct');
      await settle();
      expect(mockedPost).toHaveBeenCalledTimes(MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT + 2);

      // Full again: the next one is dropped.
      await fire('acct-new', 'conversion', 'acct');
      expect(mockedPost).toHaveBeenCalledTimes(MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT + 2);

      pending.forEach((p) => p.resolve());
      await Promise.all([...running, afterSuccess, afterFailure]);

      // Timeout: a nameserver that never answers holds every slot until the deadline.
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      // The answers above are cached for a while; past that, DNS is asked again.
      await jest.advanceTimersByTimeAsync(WEBHOOK_DNS_CACHE_MS);
      dnsNeverAnswers();
      const stuck = fireForAccount('acct', MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT, perProject);
      await settle();
      const asked = askedDns();
      await fire('acct-new', 'conversion', 'acct');
      expect(askedDns()).toBe(asked);

      await jest.advanceTimersByTimeAsync(WEBHOOK_TIMEOUT_MS);
      await settle();
      await Promise.all(stuck);
      // Those webhooks stalled, so they are left alone for the cool-down.
      await jest.advanceTimersByTimeAsync(WEBHOOK_COOLDOWN_START_MS);
      dnsAnswers('93.184.216.34');
      mockedPost.mockReset();
      mockedPost.mockResolvedValue({ status: 200 });
      // Back from a cool-down, each webhook gets one delivery until it answers...
      const projects = MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT / perProject;
      await Promise.all(fireForAccount('acct', MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT, perProject));
      expect(mockedPost).toHaveBeenCalledTimes(projects);
      // ...and then the account's slots are all there again.
      mockedPost.mockClear();
      const later = fireForAccount('acct', MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT, perProject);
      await settle();
      await Promise.all(later);
      expect(mockedPost).toHaveBeenCalledTimes(MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT);
    });

    it('keeps part of a project\'s slots for conversions when its clicks stall', async () => {
      const pending = holdDeliveries();
      const clicks = Array.from({ length: MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT }, () => fire('shop', 'click'));
      await settle();
      const clickCap = clickShareOf(MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT);
      expect(clickCap).toBeLessThan(MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT);
      expect(mockedPost).toHaveBeenCalledTimes(clickCap);

      // A conversion on the same, click-saturated project still goes.
      const conversion = fire('shop', 'conversion');
      await settle();
      expect(mockedPost).toHaveBeenCalledTimes(clickCap + 1);

      pending.forEach((p) => p.resolve());
      await Promise.all([...clicks, conversion]);
    });

    it('drops any delivery beyond the server-wide cap, and takes the next once one finishes', async () => {
      const pending = holdDeliveries();
      const running = Array.from({ length: MAX_IN_FLIGHT_WEBHOOKS }, (_, i) => fire(`p${i}`));
      await settle();
      expect(mockedPost).toHaveBeenCalledTimes(MAX_IN_FLIGHT_WEBHOOKS);

      await fire('late');
      expect(mockedPost).toHaveBeenCalledTimes(MAX_IN_FLIGHT_WEBHOOKS);
      expect(dropWarnings()).toEqual([expect.stringContaining('project late')]);

      pending[0].reject(new Error('ECONNRESET'));
      await settle();
      const next = fire('late');
      await settle();
      expect(mockedPost).toHaveBeenCalledTimes(MAX_IN_FLIGHT_WEBHOOKS + 1);

      pending.forEach((p) => p.resolve());
      await Promise.all([...running, next]);
    });

    it('logs drops once per project per interval, with how many there were', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const pending = holdDeliveries();
      const running = Array.from({ length: MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT }, () => fire('busy'));
      await settle();

      for (let i = 0; i < 50; i++) await fire('busy');
      // The first drop is reported at once; the rest are only counted.
      expect(dropWarnings()).toHaveLength(1);
      // Another project's drops are reported on their own.
      const others = Array.from({ length: MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT }, () => fire('other'));
      await settle();
      await fire('other');
      expect(dropWarnings()).toHaveLength(2);

      await jest.advanceTimersByTimeAsync(WEBHOOK_DROP_LOG_INTERVAL_MS);
      await fire('busy');
      expect(dropWarnings()).toHaveLength(3);
      // 49 held back since the first report, plus this one.
      expect(dropWarnings()[2]).toMatch(
        /Webhook deliveries for project busy since the last report: 50 dropped \(too many deliveries in flight for the project\)/,
      );

      pending.forEach((p) => p.resolve());
      await Promise.all([...running, ...others]);
    });

    it('gives up on a nameserver that never answers within the delivery timeout, and frees the slots', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      dnsNeverAnswers();
      const stuck = Array.from({ length: MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT }, () => fire('slowdns'));
      await settle();
      expect(askedDns()).toBe(MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT);

      // A delivery waiting on DNS holds its slot, so one more is dropped
      // before it asks: otherwise the caps would not bound how many queries
      // a stalled nameserver can have outstanding.
      await fire('slowdns');
      expect(dropWarnings()).toEqual([expect.stringContaining('project slowdns')]);
      expect(askedDns()).toBe(MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT);

      let finished = 0;
      stuck.forEach((p) => p.then(() => finished++));
      await jest.advanceTimersByTimeAsync(WEBHOOK_TIMEOUT_MS - 1);
      expect(finished).toBe(0);
      await jest.advanceTimersByTimeAsync(1);
      await settle();
      expect(finished).toBe(MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT);
      expect(mockedPost).not.toHaveBeenCalled();

      // Cooling down, and the host's refusal cached, for the same while.
      dnsAnswers('93.184.216.34');
      await fire('slowdns');
      expect(mockedPost).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(WEBHOOK_COOLDOWN_START_MS);
      await fire('slowdns');
      expect(mockedPost).toHaveBeenCalledTimes(1);
    });

    it('does not send at all when DNS used up the whole deadline', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      // The answer arrives as the clock reaches the deadline, before the
      // resolver's own timer has had its turn, so only the service's check
      // stands between this and a request with no time left.
      resolver.resolve4.mockImplementation(async () => {
        jest.setSystemTime(Date.now() + WEBHOOK_TIMEOUT_MS);
        return ['93.184.216.34'];
      });
      resolver.resolve6.mockImplementation(noData);

      await fire('late-dns');

      expect(mockedPost).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('timed out'));
      // And its slot is free again, once the stall's cool-down is over.
      await jest.advanceTimersByTimeAsync(WEBHOOK_COOLDOWN_START_MS);
      dnsAnswers('93.184.216.34');
      await fire('late-dns');
      expect(mockedPost).toHaveBeenCalledTimes(1);
    });

    it('gives the request only what is left of the one deadline after DNS', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      let answer!: (a: string[]) => void;
      resolver.resolve4.mockImplementation(() => new Promise((r) => (answer = r)));
      resolver.resolve6.mockImplementation(noData);
      const delivery = fire('slowish');
      await settle();
      await jest.advanceTimersByTimeAsync(2000);
      answer(['93.184.216.34']);
      await settle();
      await delivery;

      expect(mockedPost).toHaveBeenCalledTimes(1);
      expect(mockedPost.mock.calls[0][1].timeoutMs).toBe(WEBHOOK_TIMEOUT_MS - 2000);
    });
  });

  // One event used to hold one slot for every webhook of the project in turn,
  // and nothing limited how many webhooks a project had: 1000 webhooks at a
  // tarpit held a slot for 83 minutes per click.
  describe('webhooks per project', () => {
    const dto = { url: 'https://example.com/hook', events: ['conversion'] } as any;
    const CAP_MESSAGE = `A project can have at most ${MAX_WEBHOOKS_PER_PROJECT} active webhooks. Turn one off or delete one first.`;
    beforeEach(() => {
      mockWebhookRepo.create.mockImplementation((v) => v);
      mockWebhookRepo.save.mockImplementation(async (v) => ({ id: 'new', ...v }));
      mockWebhookRepo.count.mockImplementation(async () => 0);
    });

    it('refuses an active webhook beyond the cap', async () => {
      mockWebhookRepo.count.mockResolvedValue(MAX_WEBHOOKS_PER_PROJECT);
      const err = await service.create('proj-1', dto, ACTOR, CTX).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toBe(CAP_MESSAGE);
      expect(mockWebhookRepo.save).not.toHaveBeenCalled();
    });

    it('allows the last one up to the cap', async () => {
      mockWebhookRepo.count.mockResolvedValue(MAX_WEBHOOKS_PER_PROJECT - 1);
      await expect(service.create('proj-1', dto, ACTOR, CTX)).resolves.toHaveProperty('id', 'new');
    });

    it('still allows an inactive one at the cap', async () => {
      mockWebhookRepo.count.mockResolvedValue(MAX_WEBHOOKS_PER_PROJECT);
      await expect(service.create('proj-1', { ...dto, isActive: false }, ACTOR, CTX)).resolves.toHaveProperty('id', 'new');
    });

    it('refuses turning one on at the cap, and still allows turning one off', async () => {
      storeRow({ id: 'w1', projectId: 'proj-1', url: 'https://example.com/hook', events: ['conversion'], isActive: false });
      mockWebhookRepo.count.mockResolvedValue(MAX_WEBHOOKS_PER_PROJECT);
      const err = await service.update('w1', 'proj-1', { isActive: true }, ACTOR, CTX).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toBe(CAP_MESSAGE);
      expect(mockWebhookRepo.update).not.toHaveBeenCalled();

      await expect(service.update('w1', 'proj-1', { isActive: false }, ACTOR, CTX)).resolves.toMatchObject({ isActive: false });
    });

    it('sends only to the oldest webhooks of a project over the cap, and says so once', async () => {
      const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
      const rows = Array.from({ length: MAX_WEBHOOKS_PER_PROJECT + 2 }, (_, n) => ({
        id: `w${n}`,
        projectId: 'legacy',
        project: { id: 'legacy', ownerId: 'o' },
        url: `https://h${n}.example.com/hook`,
        events: ['conversion'],
        secretSealed: sealed('s1'),
        isActive: true,
      }));
      // Oldest first, as the query asks for; the integration spec proves the
      // query returns them that way.
      mockWebhookRepo.find.mockResolvedValue(rows);

      await service.fireWebhook('legacy', 'conversion', {});
      await service.fireWebhook('legacy', 'conversion', {});

      const hosts = mockedPost.mock.calls.map(([t]) => t.hostname);
      expect(hosts).toHaveLength(2 * MAX_WEBHOOKS_PER_PROJECT);
      expect(new Set(hosts)).toEqual(new Set(rows.slice(0, MAX_WEBHOOKS_PER_PROJECT).map((r) => new URL(r.url).hostname)));
      const told = warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('active webhooks'));
      expect(told).toEqual([expect.stringContaining('Project legacy')]);
    });
  });

  describe('fireWebhook slot-time', () => {
    const hook = (projectId: string, n: number, ownerId = `owner-${projectId}`, host = `h${n}-${projectId}.example.com`) => ({
      id: `w${n}-${projectId}`,
      projectId,
      project: { id: projectId, ownerId },
      url: `https://${host}/hook`,
      events: ['click', 'conversion'],
      secretSealed: sealed('s1'),
      isActive: true,
    });
    /** What the real transport does against a receiver that accepts and never answers. */
    const stalled = (req: { timeoutMs: number }) =>
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(Object.assign(new Error(`Webhook timed out after ${req.timeoutMs}ms`), { code: 'ETIMEDOUT' })),
          req.timeoutMs,
        ),
      );
    /** Hosts starting "tarpit" never answer; the rest answer 200 at once. */
    const tarpitHosts = () =>
      mockedPost.mockImplementation((target, req) =>
        target.hostname.startsWith('tarpit') ? stalled(req) : Promise.resolve({ status: 200 }),
      );
    const settle = async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    };
    const fireRows = (projectId: string, rows: unknown[], event = 'conversion') => {
      mockWebhookRepo.find.mockResolvedValueOnce(rows);
      return service.fireWebhook(projectId, event, {});
    };
    const notFound = () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' }));

    let warn: jest.SpyInstance;
    const lines = () => warn.mock.calls.map(([m]) => String(m));
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      // Every logger, so a line written anywhere on the delivery path counts.
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => {
      jest.useRealTimers();
      warn.mockRestore();
    });

    it('finishes one event to a project of tarpits within one overall deadline', async () => {
      expect(WEBHOOK_EVENT_DEADLINE_MS).toBeLessThanOrEqual(2 * WEBHOOK_TIMEOUT_MS);
      tarpitHosts();
      const rows = Array.from({ length: MAX_WEBHOOKS_PER_PROJECT }, (_, n) =>
        hook('slow', n, undefined, `tarpit.example${n}.com`),
      );
      const started = Date.now();
      let finishedAt: number | null = null;
      const event = fireRows('slow', rows).then(() => (finishedAt = Date.now()));
      await settle();
      await jest.advanceTimersByTimeAsync(WEBHOOK_EVENT_DEADLINE_MS);
      await settle();

      expect(finishedAt).not.toBeNull();
      expect(finishedAt! - started).toBeLessThanOrEqual(WEBHOOK_EVENT_DEADLINE_MS);
      // Every one was tried: at once up to the project's cap, the rest as
      // the event's own slots came back.
      expect(mockedPost).toHaveBeenCalledTimes(MAX_WEBHOOKS_PER_PROJECT);
      await event;
    });

    it('drops what it could not start by the deadline, and counts it', async () => {
      tarpitHosts();
      // A slow suspension check leaves the deliveries half a timeout.
      suspension.isSuspended.mockImplementationOnce(
        () => new Promise((r) => setTimeout(() => r(false), WEBHOOK_EVENT_DEADLINE_MS - WEBHOOK_TIMEOUT_MS / 2)),
      );
      const rows = Array.from({ length: MAX_WEBHOOKS_PER_PROJECT }, (_, n) =>
        hook('late', n, undefined, `tarpit.example${n}.com`),
      );
      const event = fireRows('late', rows);
      await settle();
      await jest.advanceTimersByTimeAsync(WEBHOOK_EVENT_DEADLINE_MS);
      await settle();
      await event;

      expect(mockedPost).toHaveBeenCalledTimes(MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT);
      expect(mockedPost.mock.calls[0][1].timeoutMs).toBe(WEBHOOK_TIMEOUT_MS / 2);
      expect(lines()).toEqual([
        expect.stringContaining(
          `${MAX_WEBHOOKS_PER_PROJECT - MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT} dropped (event deadline passed)`,
        ),
      ]);
    });

    it('skips a webhook that stalled for its cool-down, without taking a slot', async () => {
      const pending: (() => void)[] = [];
      mockedPost.mockImplementation((target, req) =>
        target.hostname.startsWith('tarpit')
          ? stalled(req)
          : new Promise((resolve) => pending.push(() => resolve({ status: 200 }))),
      );
      const tarpit = hook('shop', 0, undefined, 'tarpit.example.com');
      // Another endpoint of the same project.
      const fine = hook('shop', 1, undefined, 'fine.example.org');
      const first = fireRows('shop', [tarpit]);
      await settle();
      await jest.advanceTimersByTimeAsync(WEBHOOK_TIMEOUT_MS);
      await first;
      mockedPost.mockClear();

      // As many events as the project has slots. Had the tarpit taken one in
      // each, the fine receiver would be dropped half way through.
      const events = Array.from({ length: MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT }, () => fireRows('shop', [tarpit, fine]));
      await settle();
      expect(mockedPost.mock.calls.map(([t]) => t.hostname)).toEqual(
        Array(MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT).fill('fine.example.org'),
      );
      pending.forEach((finish) => finish());
      await Promise.all(events);
    });

    it('tries a stalled webhook again after 30s, doubling to 10 minutes, and forgets on any answer', async () => {
      let answers = false;
      mockedPost.mockImplementation((_t, req) => (answers ? Promise.resolve({ status: 500 }) : stalled(req)));
      const tarpit = hook('shop', 0, undefined, 'tarpit.example.com');
      const posts = () => mockedPost.mock.calls.length;
      /** One event, run to its end. */
      const send = async () => {
        const event = fireRows('shop', [tarpit]);
        await settle();
        await jest.advanceTimersByTimeAsync(WEBHOOK_TIMEOUT_MS);
        await event;
      };
      /** Fires one event; if it was sent after all, runs it to its end. */
      const skippedNow = async () => {
        const before = posts();
        const event = fireRows('shop', [tarpit]);
        await settle();
        const skipped = posts() === before;
        if (!skipped) await jest.advanceTimersByTimeAsync(WEBHOOK_TIMEOUT_MS);
        await event;
        return skipped;
      };

      await send();
      expect(posts()).toBe(1);
      let cooldown = WEBHOOK_COOLDOWN_START_MS;
      const seen: number[] = [];
      for (let round = 0; round < 7; round++) {
        await jest.advanceTimersByTimeAsync(cooldown - 1);
        expect(await skippedNow()).toBe(true);
        await jest.advanceTimersByTimeAsync(1);
        const before = posts();
        await send();
        expect(posts()).toBe(before + 1);
        seen.push(cooldown);
        cooldown = Math.min(cooldown * 2, WEBHOOK_COOLDOWN_MAX_MS);
      }
      expect(seen).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);

      // Any status, even a 500, shows the endpoint answers.
      await jest.advanceTimersByTimeAsync(cooldown);
      answers = true;
      await send();
      answers = false;
      const before = posts();
      await send();
      expect(posts()).toBe(before + 1);
      // And the next stall starts again from 30s.
      await jest.advanceTimersByTimeAsync(WEBHOOK_COOLDOWN_START_MS - 1);
      expect(await skippedNow()).toBe(true);
      await jest.advanceTimersByTimeAsync(1);
      expect(await skippedNow()).toBe(false);
    });

    it('sends one delivery at a time to a webhook back from a cool-down', async () => {
      tarpitHosts();
      const tarpit = hook('shop', 0, undefined, 'tarpit.example.com');
      const first = fireRows('shop', [tarpit]);
      await settle();
      await jest.advanceTimersByTimeAsync(WEBHOOK_TIMEOUT_MS);
      await first;
      await jest.advanceTimersByTimeAsync(WEBHOOK_COOLDOWN_START_MS);
      mockedPost.mockClear();

      const events = Array.from({ length: MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT }, () => fireRows('shop', [tarpit]));
      await settle();
      expect(mockedPost).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(WEBHOOK_TIMEOUT_MS);
      await Promise.all(events);
    });

    it('still gives another account a slot while 30 accounts each have a tarpit', async () => {
      tarpitHosts();
      const accounts = 30;
      const tarpitOf = (a: number) => hook(`evil${a}`, 0, `evil-owner${a}`, `tarpit${a}.example.com`);
      // Each tarpit stalls once...
      const firstRound = Array.from({ length: accounts }, (_, a) => fireRows(`evil${a}`, [tarpitOf(a)]));
      await settle();
      await jest.advanceTimersByTimeAsync(WEBHOOK_TIMEOUT_MS);
      await Promise.all(firstRound);
      mockedPost.mockClear();

      // ...then every account fires as many events as its cap holds: far
      // more, together, than the whole server's cap.
      expect(accounts * MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT).toBeGreaterThan(MAX_IN_FLIGHT_WEBHOOKS);
      const flood: Promise<void>[] = [];
      for (let a = 0; a < accounts; a++) {
        for (let i = 0; i < MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT; i++) flood.push(fireRows(`evil${a}`, [tarpitOf(a)]));
      }
      await settle();
      const neighbour = fireRows('neighbour', [hook('neighbour', 0)]);
      await settle();

      expect(mockedPost.mock.calls.map(([t]) => t.hostname)).toEqual(['h0-neighbour.example.com']);
      await jest.advanceTimersByTimeAsync(WEBHOOK_EVENT_DEADLINE_MS);
      await Promise.all([...flood, neighbour]);
    });

    it('sums up failures per project per interval instead of writing a line per delivery', async () => {
      resolver.resolve4.mockImplementation(notFound);
      resolver.resolve6.mockImplementation(notFound);
      const rows = Array.from({ length: MAX_WEBHOOKS_PER_PROJECT }, (_, n) =>
        hook('nx', n, undefined, `gone${n}.example.com`),
      );

      await fireRows('nx', rows);
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toContain('project nx');
      expect(lines()[0]).toContain(`${MAX_WEBHOOKS_PER_PROJECT} refused (no DNS records)`);

      // More within the interval are counted, not written.
      for (let i = 0; i < 20; i++) await fireRows('nx', rows);
      expect(lines()).toHaveLength(1);

      await jest.advanceTimersByTimeAsync(WEBHOOK_DROP_LOG_INTERVAL_MS);
      await fireRows('nx', rows);
      expect(lines()).toHaveLength(2);
      expect(lines()[1]).toContain('since the last report');
      expect(lines()[1]).toContain(`${20 * MAX_WEBHOOKS_PER_PROJECT} skipped (endpoint cooling down)`);
      expect(lines()[1]).toContain(`${MAX_WEBHOOKS_PER_PROJECT} refused (no DNS records)`);
    });

    /** Holds the suspension check so the event's deliveries start with only `leftMs` before its deadline. */
    const startLate = (leftMs: number) =>
      suspension.isSuspended.mockImplementationOnce(
        () => new Promise((r) => setTimeout(() => r(false), WEBHOOK_EVENT_DEADLINE_MS - leftMs)),
      );
    /** Runs one event to its end. */
    const runEvent = async (projectId: string, rows: unknown[]) => {
      const event = fireRows(projectId, rows);
      await settle();
      await jest.advanceTimersByTimeAsync(WEBHOOK_EVENT_DEADLINE_MS);
      await settle();
      await event;
    };
    const postedTo = () => mockedPost.mock.calls.map(([t]) => t.hostname);

    // The DNS cache is shared by tenants. A lookup that ran out of a budget
    // shortened by the event's deadline was cached as a refusal of the host,
    // so one tenant could refuse hooks.slack.com for every other.
    it('does not let a lookup cut short by one event refuse that host for other tenants', async () => {
      dnsNeverAnswers();
      const attacker = hook('evil', 0, 'evil-owner', 'hooks.popular.example');
      startLate(WEBHOOK_MIN_DELIVERY_MS);
      await runEvent('evil', [attacker]);
      expect(resolver.resolve4).toHaveBeenCalledTimes(1);
      expect(mockedPost).not.toHaveBeenCalled();

      dnsAnswers('93.184.216.34');
      await runEvent('victim', [hook('victim', 0, 'victim-owner', 'hooks.popular.example')]);
      expect(postedTo()).toEqual(['hooks.popular.example']);
      // Nor is the late webhook itself cooled down for it.
      await runEvent('evil', [attacker]);
      expect(postedTo()).toEqual(['hooks.popular.example', 'hooks.popular.example']);
    });

    it('drops a delivery with less than the minimum left rather than asking DNS with no time', async () => {
      startLate(WEBHOOK_MIN_DELIVERY_MS - 1);
      await runEvent('late', [hook('late', 0)]);
      expect(resolver.resolve4).not.toHaveBeenCalled();
      expect(lines()).toEqual([expect.stringContaining('1 dropped (event deadline passed)')]);
    });

    it('does not cool a host down for other tenants when a delivery to it ran short of time', async () => {
      // Answers in 2.2s: fine with a full budget, too late with the minimum left.
      expect(WEBHOOK_MIN_DELIVERY_MS).toBeLessThan(2200);
      mockedPost.mockImplementation(
        (_t, req) =>
          new Promise((resolve, reject) =>
            req.timeoutMs >= 2200
              ? setTimeout(() => resolve({ status: 200 }), 2200)
              : setTimeout(
                  () => reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })),
                  req.timeoutMs,
                ),
          ),
      );
      startLate(WEBHOOK_MIN_DELIVERY_MS);
      await runEvent('evil', [hook('evil', 0, 'evil-owner', 'hooks.popular.example')]);
      expect(lines()).toEqual([expect.stringContaining('failed (no response in time)')]);

      await runEvent('victim', [hook('victim', 0, 'victim-owner', 'hooks.popular.example')]);
      expect(postedTo()).toEqual(['hooks.popular.example', 'hooks.popular.example']);
    });

    it('cools down a webhook that answers just inside the timeout', async () => {
      expect(WEBHOOK_SLOW_RESPONSE_MS).toBe(WEBHOOK_TIMEOUT_MS / 2);
      mockedPost.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ status: 200 }), WEBHOOK_TIMEOUT_MS - 100)),
      );
      const slow = hook('shop', 0, undefined, 'slow.example.com');
      await runEvent('shop', [slow]);
      expect(mockedPost).toHaveBeenCalledTimes(1);
      expect(lines()).toEqual([expect.stringContaining('1 delivered (answered after 2500ms, cooling down)')]);

      await runEvent('shop', [slow]);
      expect(mockedPost).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(WEBHOOK_COOLDOWN_START_MS);
      await runEvent('shop', [slow]);
      expect(mockedPost).toHaveBeenCalledTimes(2);
    });

    it('does not cool down a webhook that answers in time', async () => {
      mockedPost.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ status: 200 }), WEBHOOK_SLOW_RESPONSE_MS)),
      );
      const fine = hook('shop', 0, undefined, 'fine.example.com');
      await runEvent('shop', [fine]);
      await runEvent('shop', [fine]);
      expect(mockedPost).toHaveBeenCalledTimes(2);
    });

    it('still gives another account a slot while 30 accounts each have an endpoint that answers at 4.9s', async () => {
      mockedPost.mockImplementation((target) =>
        target.hostname.startsWith('slow')
          ? new Promise((resolve) => setTimeout(() => resolve({ status: 200 }), WEBHOOK_TIMEOUT_MS - 100))
          : Promise.resolve({ status: 200 }),
      );
      const accounts = 30;
      const slowOf = (a: number) => hook(`evil${a}`, 0, `evil-owner${a}`, `slow${a}.example.com`);
      const firstRound = Array.from({ length: accounts }, (_, a) => fireRows(`evil${a}`, [slowOf(a)]));
      await settle();
      await jest.advanceTimersByTimeAsync(WEBHOOK_TIMEOUT_MS);
      await Promise.all(firstRound);
      mockedPost.mockClear();

      const flood: Promise<void>[] = [];
      for (let a = 0; a < accounts; a++) {
        for (let i = 0; i < MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT; i++) flood.push(fireRows(`evil${a}`, [slowOf(a)]));
      }
      await settle();
      const neighbour = fireRows('neighbour', [hook('neighbour', 0)]);
      await settle();

      expect(postedTo()).toEqual(['h0-neighbour.example.com']);
      await jest.advanceTimersByTimeAsync(WEBHOOK_EVENT_DEADLINE_MS);
      await Promise.all([...flood, neighbour]);
    });

    // On a multi-tenant receiver the path picks the code that runs, so a
    // tenant decides how long its own path takes to answer. Shared across
    // accounts, one stalled path switched off every tenant's webhooks there.
    it('does not let one account\'s stalling path at a shared host stop another account\'s webhook there', async () => {
      mockedPost.mockImplementation((target, req) =>
        target.url.pathname.includes('/evil/') ? stalled(req) : Promise.resolve({ status: 200 }),
      );
      const shared = (projectId: string, ownerId: string, n: number, path: string) => ({
        ...hook(projectId, n, ownerId),
        url: `https://script.google.com/macros/s/${path}/exec`,
      });
      await runEvent('evil', [shared('evil', 'evil-owner', 0, 'evil/a')]);
      await runEvent('victim', [shared('victim', 'victim-owner', 0, 'good')]);
      expect(mockedPost).toHaveBeenCalledTimes(2);

      // Past the cool-down the attacker's probe stalls again; the victim
      // goes on being sent to while it is out.
      await jest.advanceTimersByTimeAsync(WEBHOOK_COOLDOWN_START_MS);
      const probe = fireRows('evil', [shared('evil', 'evil-owner', 0, 'evil/a')]);
      await settle();
      await runEvent('victim', [shared('victim', 'victim-owner', 0, 'good')]);
      await probe;
      expect(mockedPost.mock.calls.map(([t]) => t.url.pathname)).toEqual([
        '/macros/s/evil/a/exec',
        '/macros/s/good/exec',
        '/macros/s/evil/a/exec',
        '/macros/s/good/exec',
      ]);
    });

    it('cools down a webhook that refused the connection, without taking a slot', async () => {
      const pending: (() => void)[] = [];
      mockedPost.mockImplementation((target) =>
        target.hostname.endsWith('closed.example.com')
          ? Promise.reject(Object.assign(new Error('connect ECONNREFUSED 93.184.216.34:443'), { code: 'ECONNREFUSED' }))
          : new Promise((resolve) => pending.push(() => resolve({ status: 200 }))),
      );
      const closed = hook('shop', 0, 'owner', 'api.closed.example.com');
      await runEvent('shop', [closed]);
      expect(postedTo()).toEqual(['api.closed.example.com']);
      expect(lines()).toEqual([expect.stringContaining('1 failed (could not connect: ECONNREFUSED)')]);
      mockedPost.mockClear();

      // As many events as the project has slots, each with the refusing
      // webhook first. Had it taken a slot in each, the other receiver would
      // be dropped half way through.
      const fine = hook('shop', 1, 'owner', 'fine.example.org');
      const events = Array.from({ length: MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT }, () => fireRows('shop', [closed, fine]));
      await settle();
      expect(postedTo()).toEqual(Array(MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT).fill('fine.example.org'));
      pending.forEach((finish) => finish());
      await Promise.all(events);
      mockedPost.mockClear();

      // Other projects at that URL, of the same account or another, are sent to.
      await fireRows('shop2', [{ ...hook('shop2', 0, 'owner'), url: closed.url }]);
      await fireRows('other', [{ ...hook('other', 0, 'other-owner'), url: closed.url }]);
      expect(postedTo()).toEqual(['api.closed.example.com', 'api.closed.example.com']);
    });

    it('cools down tarpits started late in an event, once the first ones have stalled', async () => {
      tarpitHosts();
      // A few milliseconds of query time, so the ones started as the first
      // stalls end get just under a full timeout.
      startLate(WEBHOOK_EVENT_DEADLINE_MS - 10);
      expect(MAX_WEBHOOKS_PER_PROJECT).toBeGreaterThan(MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT);
      const rows = Array.from({ length: MAX_WEBHOOKS_PER_PROJECT }, (_, n) =>
        hook('slow', n, undefined, `tarpit.example${n}.com`),
      );
      await runEvent('slow', rows);
      expect(mockedPost).toHaveBeenCalledTimes(MAX_WEBHOOKS_PER_PROJECT);
      expect(mockedPost.mock.calls[MAX_WEBHOOKS_PER_PROJECT - 1][1].timeoutMs).toBeLessThan(WEBHOOK_TIMEOUT_MS);
      mockedPost.mockClear();

      // Every one cooled down, so the next event holds no slot at all.
      await runEvent('slow', rows);
      expect(mockedPost).not.toHaveBeenCalled();
    });

    it('cools down a webhook that stalled on a budget cut short but over the slow-answer limit', async () => {
      tarpitHosts();
      const left = WEBHOOK_SLOW_RESPONSE_MS + 1000;
      startLate(left);
      const row = hook('shop', 0, undefined, 'tarpit.example.com');
      await runEvent('shop', [row]);
      expect(mockedPost.mock.calls[0][1].timeoutMs).toBe(left);
      mockedPost.mockClear();

      // An answer that late would have cooled it down, so no answer does too.
      await runEvent('shop', [row]);
      expect(mockedPost).not.toHaveBeenCalled();
    });

    it('cools down only the URL whose lookup failed, not the host', async () => {
      dnsNeverAnswers();
      await runEvent('a', [hook('a', 0, undefined, 'flaky.example.com')]);
      dnsAnswers('93.184.216.34');
      // The URL that saw it waits; another of the project's at the same host does not.
      await runEvent('a', [hook('a', 0, undefined, 'flaky.example.com')]);
      expect(mockedPost).not.toHaveBeenCalled();
      await runEvent('a', [{ ...hook('a', 1), url: 'https://flaky.example.com/other' }]);
      expect(postedTo()).toEqual(['flaky.example.com']);
    });

    it('forgets a webhook\'s cool-down when its URL is changed', async () => {
      tarpitHosts();
      const row = hook('shop', 0, undefined, 'tarpit.example.com');
      await runEvent('shop', [row]);
      mockedPost.mockClear();

      storeRow(row);
      await service.update(row.id, 'shop', { url: 'https://fixed.example.org/hook' } as any, ACTOR, CTX);
      await runEvent('shop', [{ ...row, url: 'https://fixed.example.org/hook' }]);
      expect(postedTo()).toEqual(['fixed.example.org']);
    });

    it('keeps the cool-down when an update leaves the URL as it was', async () => {
      tarpitHosts();
      const row = hook('shop', 0, undefined, 'tarpit.example.com');
      await runEvent('shop', [row]);
      mockedPost.mockClear();
      storeRow(row);
      await service.update(row.id, 'shop', { url: row.url, events: ['conversion'] } as any, ACTOR, CTX);
      await runEvent('shop', [row]);
      expect(mockedPost).not.toHaveBeenCalled();
    });

    it('asks DNS about a refused host once per cool-down, whichever of the project\'s webhooks uses it', async () => {
      resolver.resolve4.mockImplementation(notFound);
      resolver.resolve6.mockImplementation(notFound);
      for (let n = 0; n < 5; n++) {
        await fireRows('p', [{ ...hook('p', n), url: `https://gone.example.com/hook${n}` }]);
      }
      expect(resolver.resolve4).toHaveBeenCalledTimes(1);
      expect(mockedPost).not.toHaveBeenCalled();
    });

    it('does not let a fast delivery started before a slow one clear the cool-down it earned', async () => {
      let calls = 0;
      mockedPost.mockImplementation((_t, req) =>
        calls++ === 0 ? stalled(req) : new Promise((resolve) => setTimeout(() => resolve({ status: 200 }), 1500)),
      );
      const row = hook('shop', 0, undefined, 'flip.example.com');
      const stall = fireRows('shop', [row]);
      await settle();
      await jest.advanceTimersByTimeAsync(WEBHOOK_TIMEOUT_MS - 1000);
      // Answers fast, half a second after the stall has ended.
      const fast = fireRows('shop', [row]);
      await settle();
      await jest.advanceTimersByTimeAsync(1500);
      await Promise.all([stall, fast]);
      expect(mockedPost).toHaveBeenCalledTimes(2);

      await runEvent('shop', [row]);
      expect(mockedPost).toHaveBeenCalledTimes(2);
    });

    // What the server guarantees (WEBHOOK_ISOLATION in webhooks.service.ts):
    // every cool-down and every cached refusal belongs to one project.

    it.each([
      ['a reset', 'ECONNRESET'],
      ['a parse error', 'HPE_INVALID_CONSTANT'],
    ])('cools down a webhook whose delivery ended in %s after the slow-answer limit', async (_what, code) => {
      mockedPost.mockImplementation(
        () =>
          new Promise((_, reject) =>
            setTimeout(() => reject(Object.assign(new Error('socket hang up'), { code })), WEBHOOK_TIMEOUT_MS - 100),
          ),
      );
      const row = hook('shop', 0, undefined, 'reset.example.com');
      await runEvent('shop', [row]);
      expect(lines()).toEqual([expect.stringContaining(`1 failed (${code})`)]);
      await runEvent('shop', [row]);
      expect(mockedPost).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(WEBHOOK_COOLDOWN_START_MS);
      await runEvent('shop', [row]);
      expect(mockedPost).toHaveBeenCalledTimes(2);
    });

    it('does not cool down a webhook whose delivery was reset at once', async () => {
      mockedPost.mockImplementation(() =>
        Promise.reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })),
      );
      const row = hook('shop', 0, undefined, 'reset.example.com');
      await runEvent('shop', [row]);
      await runEvent('shop', [row]);
      expect(mockedPost).toHaveBeenCalledTimes(2);
    });

    it('cools down a webhook whose lookup alone took past the slow-answer limit', async () => {
      resolver.resolve4.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(['93.184.216.34']), WEBHOOK_SLOW_RESPONSE_MS + 500)),
      );
      const row = hook('shop', 0, undefined, 'slowdns.example.com');
      await runEvent('shop', [row]);
      await runEvent('shop', [row]);
      expect(mockedPost).toHaveBeenCalledTimes(1);
    });

    it('does not let one project\'s stall at a host stop another project\'s webhook there, even in the same account', async () => {
      tarpitHosts();
      await runEvent('a', [hook('a', 0, 'owner', 'tarpit.example.com')]);
      await runEvent('b', [hook('b', 0, 'owner', 'tarpit.example.com')]);
      await runEvent('c', [hook('c', 0, 'other-owner', 'tarpit.example.com')]);
      expect(postedTo()).toEqual(['tarpit.example.com', 'tarpit.example.com', 'tarpit.example.com']);
      // The project that stalled is the one that waits.
      await runEvent('a', [hook('a', 0, 'owner', 'tarpit.example.com')]);
      expect(mockedPost).toHaveBeenCalledTimes(3);
    });

    it('keeps the cool-down when a webhook is deleted and made again with the same URL', async () => {
      tarpitHosts();
      const row = hook('shop', 0, undefined, 'tarpit.example.com');
      await runEvent('shop', [row]);
      mockWebhookRepo.findOne.mockResolvedValueOnce(row);
      await service.remove(row.id, 'shop', ACTOR, CTX);
      // A new id, and the same URL spelled differently.
      await runEvent('shop', [{ ...hook('shop', 1), url: 'HTTPS://Tarpit.Example.com:443/hook' }]);
      expect(mockedPost).toHaveBeenCalledTimes(1);
      // Another path is another endpoint.
      await runEvent('shop', [{ ...hook('shop', 2), url: 'https://tarpit.example.com/other' }]);
      expect(mockedPost).toHaveBeenCalledTimes(2);
    });

    it('keeps a refused name for the project that saw it, and asks again for another project', async () => {
      resolver.resolve4.mockImplementation(notFound);
      resolver.resolve6.mockImplementation(notFound);
      await fireRows('a', [hook('a', 0, 'owner', 'gone.example.com')]);
      await fireRows('a', [hook('a', 1, 'owner', 'gone.example.com')]);
      expect(resolver.resolve4).toHaveBeenCalledTimes(1);

      // The name exists now. Another project, even of the same account, asks.
      dnsAnswers('93.184.216.34');
      await fireRows('b', [hook('b', 0, 'owner', 'gone.example.com')]);
      expect(postedTo()).toEqual(['gone.example.com']);
      // The project that saw the refusal keeps it for its cool-down.
      await fireRows('a', [hook('a', 2, 'owner', 'gone.example.com')]);
      expect(postedTo()).toEqual(['gone.example.com']);
    });

    it('does not cache a refusal from a lookup the event\'s deadline cut short', async () => {
      resolver.resolve4.mockImplementation(notFound);
      resolver.resolve6.mockImplementation(notFound);
      startLate(WEBHOOK_MIN_DELIVERY_MS);
      await runEvent('shop', [hook('shop', 0, undefined, 'new.example.com')]);
      expect(resolver.resolve4).toHaveBeenCalledTimes(1);

      dnsAnswers('93.184.216.34');
      // Another URL at the name: the one that was refused has its own cool-down.
      await runEvent('shop', [{ ...hook('shop', 1), url: 'https://new.example.com/other' }]);
      await runEvent('other', [hook('other', 0, undefined, 'new.example.com')]);
      expect(postedTo()).toEqual(['new.example.com', 'new.example.com']);
    });

    it('counts a cool-down forgotten to make room in the project\'s report', async () => {
      // Small caps stand in for the real ones, which take hundreds of URLs to reach.
      (service as any).cooldown = new EndpointCooldown(100, 1);
      mockedPost.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      await fireRows('shop', [hook('shop', 0), hook('shop', 1)]);
      expect(lines()).toEqual([expect.stringContaining('1 cool-down list full (oldest forgotten)')]);
    });

    it('counts a DNS answer forgotten to make room in the project\'s report', async () => {
      (service as any).dnsCache = new WebhookDnsCache(100, 1);
      await fireRows('shop', [hook('shop', 0), hook('shop', 1)]);
      expect(lines()).toEqual([expect.stringContaining('1 DNS cache full (oldest forgotten)')]);
    });

    it('does not start a delivery with less than a whole DNS budget left', async () => {
      expect(WEBHOOK_MIN_DELIVERY_MS).toBeGreaterThanOrEqual(WEBHOOK_MIN_DNS_BUDGET_MS);
      startLate(WEBHOOK_MIN_DNS_BUDGET_MS - 1);
      await runEvent('late', [hook('late', 0)]);
      expect(resolver.resolve4).not.toHaveBeenCalled();
      expect(lines()).toEqual([expect.stringContaining('1 dropped (event deadline passed)')]);
    });
  });

  describe('DeliveryReport', () => {
    // Pruning only dropped projects with nothing held back, so projects that
    // all failed within the same minute grew the map without limit.
    it('tracks at most its cap of projects, forgetting the oldest', () => {
      const reports = new DeliveryReport(3);
      const failed = () => {
        const tally = new Tally();
        tally.add('failed (ECONNRESET)');
        return tally;
      };
      for (let n = 0; n < 4; n++) {
        reports.record(`p${n}`, failed(), 0);
        // Something held back for each, so none can be pruned.
        reports.record(`p${n}`, failed(), 1);
      }
      expect(reports.size).toBe(3);
      // p0 was forgotten, so it is due a line again at once.
      expect(reports.record('p0', failed(), 2)).not.toBeNull();
      expect(reports.record('p3', failed(), 2)).toBeNull();
    });
  });

  describe('InFlightDeliveries', () => {
    const conversion = (projectId: string, accountId = `a-${projectId}`) => ({ projectId, accountId, click: false });
    const click = (projectId: string, accountId = `a-${projectId}`) => ({ projectId, accountId, click: true });
    const acquired = (r: ReturnType<InFlightDeliveries['tryAcquire']>) => 'release' in r;
    const releaseOf = (r: ReturnType<InFlightDeliveries['tryAcquire']>) => (r as { release: () => void }).release;

    it('sizes the server-wide cap well above one account\'s', () => {
      // A safety net for the process, not the limit tenants meet first.
      expect(MAX_IN_FLIGHT_WEBHOOKS).toBeGreaterThanOrEqual(16 * MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT);
      expect(MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT).toBeGreaterThan(MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT);
    });

    it('frees a slot once however often its release is called', () => {
      const slots = new InFlightDeliveries();
      const held = Array.from({ length: MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT }, () => slots.tryAcquire(conversion('p')));
      expect(held.every(acquired)).toBe(true);
      expect(slots.tryAcquire(conversion('p'))).toEqual({ refused: 'project' });

      releaseOf(held[0])();
      releaseOf(held[0])();
      // One slot came back, not two: a repeated release must not let the
      // project go past its cap.
      expect(acquired(slots.tryAcquire(conversion('p')))).toBe(true);
      expect(slots.tryAcquire(conversion('p'))).toEqual({ refused: 'project' });
    });

    it('counts a repeated release once against the server cap too', () => {
      const slots = new InFlightDeliveries();
      const held = Array.from({ length: MAX_IN_FLIGHT_WEBHOOKS }, (_, i) => slots.tryAcquire(conversion(`p${i}`)));
      expect(held.every(acquired)).toBe(true);
      expect(slots.tryAcquire(conversion('extra'))).toEqual({ refused: 'server' });

      releaseOf(held[0])();
      releaseOf(held[0])();
      expect(acquired(slots.tryAcquire(conversion('extra')))).toBe(true);
      expect(slots.tryAcquire(conversion('another'))).toEqual({ refused: 'server' });
    });

    it('counts a repeated release once against the account cap too', () => {
      const slots = new InFlightDeliveries();
      const held = Array.from({ length: MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT }, (_, i) =>
        slots.tryAcquire(conversion(`q${i}`, 'acct')),
      );
      expect(held.every(acquired)).toBe(true);
      expect(slots.tryAcquire(conversion('q-new', 'acct'))).toEqual({ refused: 'account' });

      releaseOf(held[0])();
      releaseOf(held[0])();
      expect(acquired(slots.tryAcquire(conversion('q-new', 'acct')))).toBe(true);
      expect(slots.tryAcquire(conversion('q-newer', 'acct'))).toEqual({ refused: 'account' });
    });

    it('never lets clicks take the server-wide conversion reserve', () => {
      const slots = new InFlightDeliveries();
      const clickCap = clickShareOf(MAX_IN_FLIGHT_WEBHOOKS);
      expect(clickCap).toBeLessThan(MAX_IN_FLIGHT_WEBHOOKS);
      // Every click from its own account and project, so only the server cap applies.
      for (let i = 0; i < clickCap; i++) expect(acquired(slots.tryAcquire(click(`c${i}`)))).toBe(true);
      expect(slots.tryAcquire(click('one-more'))).toEqual({ refused: 'server' });

      // The rest of the pool is still there for conversions.
      for (let i = clickCap; i < MAX_IN_FLIGHT_WEBHOOKS; i++) {
        expect(acquired(slots.tryAcquire(conversion(`v${i}`)))).toBe(true);
      }
      expect(slots.tryAcquire(conversion('full'))).toEqual({ refused: 'server' });
    });

    it('lets clicks use only their share of an account\'s slots', () => {
      const slots = new InFlightDeliveries();
      const clickCap = clickShareOf(MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT);
      for (let i = 0; i < clickCap; i++) expect(acquired(slots.tryAcquire(click(`c${i}`, 'acct')))).toBe(true);
      expect(slots.tryAcquire(click('c-more', 'acct'))).toEqual({ refused: 'account' });
      expect(acquired(slots.tryAcquire(conversion('v', 'acct')))).toBe(true);
    });
  });
});
