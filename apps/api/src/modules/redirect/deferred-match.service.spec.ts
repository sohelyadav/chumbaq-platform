import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DeferredMatchService } from './deferred-match.service';
import { ClickEventEntity } from '../analytics/entities/click-event.entity';
import { LinksService } from '../links/links.service';
import { DeferredMatchDto } from './dto/deferred-match.dto';

describe('DeferredMatchService', () => {
  let service: DeferredMatchService;
  let clickEventRepo: {
    findOne: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let linksService: {
    findByShortCode: jest.Mock;
    findOne: jest.Mock;
  };
  let qbMock: {
    where: jest.Mock;
    andWhere: jest.Mock;
    innerJoin: jest.Mock;
    orderBy: jest.Mock;
    getOne: jest.Mock;
  };

  beforeEach(async () => {
    qbMock = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
    };

    clickEventRepo = {
      findOne: jest.fn(),
      save: jest.fn((x) => Promise.resolve(x)),
      createQueryBuilder: jest.fn(() => qbMock),
    };

    linksService = {
      findByShortCode: jest.fn(),
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeferredMatchService,
        {
          provide: getRepositoryToken(ClickEventEntity),
          useValue: clickEventRepo,
        },
        {
          provide: LinksService,
          useValue: linksService,
        },
      ],
    }).compile();

    service = module.get<DeferredMatchService>(DeferredMatchService);
  });

  // ---------------------------------------------------------------------------
  // Cookie-based match (Strategy 1)
  // ---------------------------------------------------------------------------
  describe('cookieRef match (Strategy 1)', () => {
    it('returns matched=true and marks click matched when cookie ref resolves to a link with an unmatched click', async () => {
      const fakeLink = {
        id: 'link-1',
        shortCode: 'abc',
        projectId: 'proj-1',
        deepLinkParams: { campaign: 'spring' },
      };
      const fakeClick: Partial<ClickEventEntity> = {
        id: 'click-1',
        linkId: 'link-1',
        matched: false,
      };

      linksService.findByShortCode.mockResolvedValueOnce(fakeLink);
      clickEventRepo.findOne.mockResolvedValueOnce(fakeClick);

      const result = await service.matchDeferred(
        { cookieRef: 'abc' },
        undefined,
        '198.51.100.5',
      );

      expect(result.matched).toBe(true);
      expect(result.linkId).toBe('link-1');
      expect(result.shortCode).toBe('abc');
      expect(result.params).toEqual({ campaign: 'spring' });
      expect(clickEventRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ matched: true }),
      );
    });

    it('searches click events ordered by clickedAt DESC with matched=false', async () => {
      linksService.findByShortCode.mockResolvedValueOnce({
        id: 'link-1',
        shortCode: 'abc',
        projectId: 'proj-1',
        deepLinkParams: {},
      });
      clickEventRepo.findOne.mockResolvedValueOnce({
        id: 'click-1',
        linkId: 'link-1',
        matched: false,
      });

      await service.matchDeferred({ cookieRef: 'abc' }, undefined, '198.51.100.5');

      const where = clickEventRepo.findOne.mock.calls[0][0].where;
      expect(where).toMatchObject({
        linkId: 'link-1',
        matched: false,
        // Bound to the requesting address: a short code alone is public.
        ipAddress: '198.51.100.5',
      });
      // And bounded in time, which this strategy used not to be.
      expect(where.clickedAt).toBeDefined();
      expect(clickEventRepo.findOne.mock.calls[0][0].order).toEqual({
        clickedAt: 'DESC',
      });
    });

    it('returns matched=false and does NOT fall through to fingerprint when project scoping fails', async () => {
      linksService.findByShortCode.mockResolvedValueOnce({
        id: 'link-1',
        shortCode: 'abc',
        projectId: 'proj-other',
        deepLinkParams: {},
      });

      const result = await service.matchDeferred(
        { cookieRef: 'abc', fingerprint: { os: 'iOS' } },
        'proj-expected',
        '1.2.3.4',
      );

      expect(result).toEqual({ matched: false });
      // Fingerprint path must not have been explored
      expect(clickEventRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('falls through to fingerprint path when cookieRef lookup throws', async () => {
      linksService.findByShortCode.mockRejectedValueOnce(new Error('not found'));

      // Fingerprint path: set up a successful match
      const fakeClick: Partial<ClickEventEntity> = {
        id: 'click-2',
        linkId: 'link-2',
        matched: false,
      };
      qbMock.getOne.mockResolvedValueOnce(fakeClick);
      linksService.findOne.mockResolvedValueOnce({
        id: 'link-2',
        shortCode: 'xyz',
        deepLinkParams: { via: 'fp' },
      });

      const result = await service.matchDeferred(
        { cookieRef: 'missing', fingerprint: { os: 'iOS' } },
        undefined,
        '1.2.3.4',
      );

      expect(result.matched).toBe(true);
      expect(result.shortCode).toBe('xyz');
    });

    it('falls through to fingerprint path when no unmatched click exists for the cookie link', async () => {
      linksService.findByShortCode.mockResolvedValueOnce({
        id: 'link-1',
        shortCode: 'abc',
        projectId: 'proj-1',
        deepLinkParams: {},
      });
      clickEventRepo.findOne.mockResolvedValueOnce(null);

      qbMock.getOne.mockResolvedValueOnce(null);

      const result = await service.matchDeferred(
        { cookieRef: 'abc', fingerprint: { os: 'iOS' } },
        undefined,
        '1.2.3.4',
      );

      // fingerprint qb was attempted
      expect(clickEventRepo.createQueryBuilder).toHaveBeenCalledWith('click');
      expect(result).toEqual({ matched: false });
    });
  });

  // ---------------------------------------------------------------------------
  // Fingerprint-based match (Strategy 2)
  // ---------------------------------------------------------------------------
  describe('fingerprint match (Strategy 2)', () => {
    it('returns matched=false when no candidate click is found', async () => {
      qbMock.getOne.mockResolvedValueOnce(null);

      const result = await service.matchDeferred(
        { fingerprint: { os: 'iOS' } },
        undefined,
        '1.2.3.4',
      );

      expect(result).toEqual({ matched: false });
      expect(clickEventRepo.save).not.toHaveBeenCalled();
    });

    it('returns matched=true and marks the click matched on fingerprint hit', async () => {
      const fakeClick: Partial<ClickEventEntity> = {
        id: 'click-2',
        linkId: 'link-2',
        matched: false,
      };
      qbMock.getOne.mockResolvedValueOnce(fakeClick);
      linksService.findOne.mockResolvedValueOnce({
        id: 'link-2',
        shortCode: 'xyz',
        deepLinkParams: { foo: 'bar' },
      });

      const result = await service.matchDeferred(
        { fingerprint: { os: 'iOS' } },
        undefined,
        '1.2.3.4',
      );

      expect(result).toEqual({
        matched: true,
        linkId: 'link-2',
        shortCode: 'xyz',
        params: { foo: 'bar' },
      });
      expect(clickEventRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ matched: true }),
      );
    });

    it('filters by ip, 48h window, store redirect types, and matched=false', async () => {
      qbMock.getOne.mockResolvedValueOnce(null);

      await service.matchDeferred(
        { fingerprint: { os: 'iOS' } },
        undefined,
        '9.8.7.6',
      );

      expect(qbMock.where).toHaveBeenCalledWith('click.ip_address = :ip', {
        ip: '9.8.7.6',
      });

      const andWhereCalls = qbMock.andWhere.mock.calls.map((c) => c[0]);
      expect(andWhereCalls).toEqual(
        expect.arrayContaining([
          'click.clicked_at >= :cutoff',
          'click.redirect_type IN (:...types)',
          'click.matched = false',
        ]),
      );

      // Cutoff should be ~48h before now
      const cutoffCall = qbMock.andWhere.mock.calls.find(
        (c) => c[0] === 'click.clicked_at >= :cutoff',
      );
      const cutoffDate: Date = cutoffCall![1].cutoff;
      const diffMs = Date.now() - cutoffDate.getTime();
      expect(diffMs).toBeGreaterThan(47 * 60 * 60 * 1000);
      expect(diffMs).toBeLessThan(49 * 60 * 60 * 1000);
    });

    it('accepts the redirect type the controller actually writes', async () => {
      // The controller records the deep-link *attempt* — it cannot know at
      // redirect time whether the app was installed, since the interstitial
      // falls back to the store in the browser ~1.5s later. `app_store` and
      // `play_store` reach `click_events` only from `seed.ts`, so a filter of
      // just those two meant this strategy never matched a real click.
      qbMock.getOne.mockResolvedValueOnce(null);

      await service.matchDeferred(
        { fingerprint: { os: 'iOS' } },
        undefined,
        '1.2.3.4',
      );

      const typesCall = qbMock.andWhere.mock.calls.find(
        (c) => c[0] === 'click.redirect_type IN (:...types)',
      );
      expect(typesCall![1].types).toContain('app_deeplink');
    });

    it('adds platform=ios filter when fingerprint os indicates iOS', async () => {
      qbMock.getOne.mockResolvedValueOnce(null);

      await service.matchDeferred(
        { fingerprint: { os: 'iOS 16' } },
        undefined,
        '1.2.3.4',
      );

      const platformCall = qbMock.andWhere.mock.calls.find(
        (c) => c[0] === 'click.platform = :platform',
      );
      expect(platformCall).toBeDefined();
      expect(platformCall![1]).toEqual({ platform: 'ios' });
    });

    it('adds platform=android filter when fingerprint os indicates Android', async () => {
      qbMock.getOne.mockResolvedValueOnce(null);

      await service.matchDeferred(
        { fingerprint: { os: 'Android 13' } },
        undefined,
        '1.2.3.4',
      );

      const platformCall = qbMock.andWhere.mock.calls.find(
        (c) => c[0] === 'click.platform = :platform',
      );
      expect(platformCall).toBeDefined();
      expect(platformCall![1]).toEqual({ platform: 'android' });
    });

    it('recognizes iphone/ipad in the os string as ios', async () => {
      qbMock.getOne.mockResolvedValueOnce(null);

      await service.matchDeferred(
        { fingerprint: { os: 'iPhone OS' } },
        undefined,
        '1.2.3.4',
      );

      const platformCall = qbMock.andWhere.mock.calls.find(
        (c) => c[0] === 'click.platform = :platform',
      );
      expect(platformCall![1]).toEqual({ platform: 'ios' });
    });

    it('does NOT add a platform filter when fingerprint os is missing or unknown', async () => {
      qbMock.getOne.mockResolvedValueOnce(null);

      await service.matchDeferred(
        { fingerprint: { os: 'SomeWeirdOS' } },
        undefined,
        '1.2.3.4',
      );

      const platformCall = qbMock.andWhere.mock.calls.find(
        (c) => c[0] === 'click.platform = :platform',
      );
      expect(platformCall).toBeUndefined();
    });

    it('scopes fingerprint candidates to expectedProjectId via inner join on links', async () => {
      qbMock.getOne.mockResolvedValueOnce(null);

      await service.matchDeferred(
        { fingerprint: { os: 'iOS' } },
        'proj-scope',
        '1.2.3.4',
      );

      expect(qbMock.innerJoin).toHaveBeenCalledWith(
        'links',
        'l',
        'l.id = click.link_id',
      );
      const projCall = qbMock.andWhere.mock.calls.find(
        (c) => c[0] === 'l.project_id = :expectedProjectId',
      );
      expect(projCall).toBeDefined();
      expect(projCall![1]).toEqual({ expectedProjectId: 'proj-scope' });
    });

    it('does NOT add project scope join when no expectedProjectId is provided', async () => {
      qbMock.getOne.mockResolvedValueOnce(null);

      await service.matchDeferred(
        { fingerprint: { os: 'iOS' } },
        undefined,
        '1.2.3.4',
      );

      expect(qbMock.innerJoin).not.toHaveBeenCalled();
    });

    it('orders candidate clicks by clicked_at DESC', async () => {
      qbMock.getOne.mockResolvedValueOnce(null);

      await service.matchDeferred(
        { fingerprint: { os: 'iOS' } },
        undefined,
        '1.2.3.4',
      );

      expect(qbMock.orderBy).toHaveBeenCalledWith('click.clicked_at', 'DESC');
    });
  });

  // ---------------------------------------------------------------------------
  // Neither strategy applicable
  // ---------------------------------------------------------------------------
  describe('no strategy applies', () => {
    it('returns matched=false when neither cookieRef nor fingerprint is provided', async () => {
      const result = await service.matchDeferred({});

      expect(result).toEqual({ matched: false });
      expect(linksService.findByShortCode).not.toHaveBeenCalled();
      expect(clickEventRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('returns matched=false when no client address could be derived', async () => {
      // An empty address would otherwise match every click row written before
      // the redirect controller could see one.
      const result = await service.matchDeferred(
        { fingerprint: { os: 'iOS' } },
        undefined,
        '',
      );

      expect(result).toEqual({ matched: false });
      expect(clickEventRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Attribution theft via a named short code
  // ---------------------------------------------------------------------------
  describe('short-code claim', () => {
    /**
     * `cookieRef` carries the link's short code — the public string in the URL
     * of every shared link — not a per-click token; no such token exists on
     * `click_events`. So naming one proved nothing, and it used to be enough:
     * with the project API key, which ships in every app binary, a caller
     * claimed any link's most recent unmatched click, flipped `matched`, and
     * got the link's `deepLinkParams` back. `getLinkPreview` exposes only OG
     * metadata, so those params were not otherwise public.
     */
    it('does not claim a click at a different address', async () => {
      const victimClick: Partial<ClickEventEntity> = {
        id: 'victim',
        linkId: 'link-1',
        matched: false,
      };
      linksService.findByShortCode.mockResolvedValue({
        id: 'link-1',
        shortCode: 'abc',
        projectId: 'proj-1',
        deepLinkParams: { order: 'victim-order' },
      });
      // Behaves like the real repository rather than like the fix: a `where`
      // that does not constrain the address matches any row, which is what
      // makes this fail if the binding is ever removed.
      clickEventRepo.findOne.mockImplementation((opts: { where: { ipAddress?: string } }) => {
        const wanted = opts.where.ipAddress;
        const matches = wanted === undefined || wanted === '203.0.113.7';
        return Promise.resolve(matches ? victimClick : null);
      });
      qbMock.getOne.mockResolvedValue(null);

      const result = await service.matchDeferred(
        { cookieRef: 'abc' },
        'proj-1',
        '198.51.100.5',
      );

      expect(result).toEqual({ matched: false });
      expect(clickEventRepo.save).not.toHaveBeenCalled();
      expect(victimClick.matched).toBe(false);
    });

    it('claims the click when the address is the one that produced it', async () => {
      // The legitimate flow still works: same device, same network.
      linksService.findByShortCode.mockResolvedValueOnce({
        id: 'link-1',
        shortCode: 'abc',
        projectId: 'proj-1',
        deepLinkParams: { campaign: 'spring' },
      });
      clickEventRepo.findOne.mockResolvedValueOnce({
        id: 'own',
        linkId: 'link-1',
        matched: false,
      });

      const result = await service.matchDeferred(
        { cookieRef: 'abc' },
        'proj-1',
        '198.51.100.5',
      );

      expect(result.matched).toBe(true);
      expect(result.params).toEqual({ campaign: 'spring' });
    });

    it('does not claim anything when the request has no address', async () => {
      const result = await service.matchDeferred({ cookieRef: 'abc' }, 'proj-1', '');

      expect(result).toEqual({ matched: false });
      expect(linksService.findByShortCode).not.toHaveBeenCalled();
    });

    it('will not claim a click older than the window', async () => {
      linksService.findByShortCode.mockResolvedValueOnce({
        id: 'link-1',
        shortCode: 'abc',
        projectId: 'proj-1',
        deepLinkParams: {},
      });
      clickEventRepo.findOne.mockResolvedValueOnce(null);
      qbMock.getOne.mockResolvedValueOnce(null);

      await service.matchDeferred({ cookieRef: 'abc' }, 'proj-1', '198.51.100.5');

      // Strategy 1 had no cutoff at all, so the oldest unclaimed click on a
      // link stayed claimable forever.
      const raw = clickEventRepo.findOne.mock.calls[0][0].where.clickedAt;
      const cutoff: Date = raw._value ?? raw.value;
      const diffMs = Date.now() - cutoff.getTime();
      expect(diffMs).toBeGreaterThan(47 * 60 * 60 * 1000);
      expect(diffMs).toBeLessThan(49 * 60 * 60 * 1000);
    });
  });

  // ---------------------------------------------------------------------------
  // Attribution theft via a client-named address
  // ---------------------------------------------------------------------------
  describe('attribution theft', () => {
    /**
     * The exploit this closes, in full: the project API key ships inside every
     * app binary, so anyone holding one used to be able to name a victim's IP
     * in `fingerprint.ip`, take the most recent unmatched store-redirect click
     * from that address, and read back the link's `deepLinkParams` — while the
     * real installer's click was now `matched` and could never be claimed
     * again. Reproduced against a live instance by seeding a click at
     * 203.0.113.7 and matching it from localhost.
     *
     * `FingerprintDto` no longer has the field, so the pipe rejects a body
     * carrying one (`dto/deferred-match.dto.spec.ts`). These assert the second
     * half: even handed one, the service matches on the request's address and
     * nothing else.
     */
    const withIp = (ip: string) =>
      ({ fingerprint: { os: 'iOS', ip } } as unknown as DeferredMatchDto);

    it('matches on the request address, never one carried in the body', async () => {
      qbMock.getOne.mockResolvedValueOnce(null);

      await service.matchDeferred(withIp('203.0.113.7'), undefined, '198.51.100.5');

      expect(qbMock.where).toHaveBeenCalledWith('click.ip_address = :ip', {
        ip: '198.51.100.5',
      });
      expect(qbMock.where).not.toHaveBeenCalledWith('click.ip_address = :ip', {
        ip: '203.0.113.7',
      });
    });

    it('cannot claim the victim click a body-supplied address points at', async () => {
      // The victim's click is really there and really unmatched. It is only
      // reachable by querying 203.0.113.7, so this fails the moment anything
      // lets the body choose the address again.
      const victimClick: Partial<ClickEventEntity> = {
        id: 'victim-click',
        linkId: 'victim-link',
        matched: false,
      };
      qbMock.getOne.mockImplementation(() => {
        const whereCall = qbMock.where.mock.calls.find(
          (c) => c[0] === 'click.ip_address = :ip',
        );
        return Promise.resolve(
          whereCall?.[1]?.ip === '203.0.113.7' ? victimClick : null,
        );
      });
      linksService.findOne.mockResolvedValue({
        id: 'victim-link',
        shortCode: 'victim',
        deepLinkParams: { order: 'victim-order-id' },
      });

      const result = await service.matchDeferred(
        withIp('203.0.113.7'),
        'proj-1',
        '198.51.100.5',
      );

      expect(result).toEqual({ matched: false });
      // No deepLinkParams disclosed, and the click is still unmatched, so the
      // real installer can still claim it.
      expect(clickEventRepo.save).not.toHaveBeenCalled();
      expect(victimClick.matched).toBe(false);
    });

    it('does not fall back to a body-supplied address when the request has none', async () => {
      const result = await service.matchDeferred(withIp('203.0.113.7'), 'proj-1', '');

      expect(result).toEqual({ matched: false });
      expect(clickEventRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});
