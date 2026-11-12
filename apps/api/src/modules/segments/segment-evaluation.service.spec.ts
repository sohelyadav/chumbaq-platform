import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SegmentEvaluationService } from './segment-evaluation.service';
import { SegmentCompilerService } from './segment-compiler.service';
import { SegmentEntity } from './entities/segment.entity';
import { SegmentMemberEntity } from './entities/segment-member.entity';

describe('SegmentEvaluationService', () => {
  let service: SegmentEvaluationService;

  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    query: jest.fn(),
  };
  const dataSource = { createQueryRunner: jest.fn(() => queryRunner) };
  const memberRepo = { find: jest.fn(), findOne: jest.fn() };

  const liveSegment = {
    id: 'seg-1', projectId: 'proj-1', evaluationMode: 'live',
    definition: { type: 'attribute', field: 'country', op: 'eq', value: 'US' },
  } as unknown as SegmentEntity;

  const materializedSegment = {
    ...liveSegment, name: 'Buyers', evaluationMode: 'materialized',
    lastMaterializedAt: new Date('2026-09-05T00:00:00Z'),
  } as unknown as SegmentEntity;

  /** Created materialized, flipped from live, or just re-defined. */
  const unmaterializedSegment = {
    ...materializedSegment, lastMaterializedAt: null,
  } as unknown as SegmentEntity;

  beforeEach(async () => {
    jest.clearAllMocks();
    queryRunner.query.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SegmentEvaluationService,
        SegmentCompilerService,
        { provide: DataSource, useValue: dataSource },
        { provide: getRepositoryToken(SegmentMemberEntity), useValue: memberRepo },
      ],
    }).compile();

    service = module.get(SegmentEvaluationService);
  });

  describe('enumerate (live)', () => {
    it('wraps the compiled SQL and pages by keyset, never OFFSET', async () => {
      queryRunner.query.mockResolvedValueOnce(undefined); // SET LOCAL
      queryRunner.query.mockResolvedValueOnce([{ person_key: 'user-1' }]);

      const keys = await service.enumerate(liveSegment, null, 500);

      const [sql, params] = queryRunner.query.mock.calls[1];
      expect(sql).toContain('ORDER BY person_key ASC');
      expect(sql).toContain('LIMIT');
      expect(sql).not.toContain('OFFSET');
      expect(params).toContain(500);
      expect(keys).toEqual(['user-1']);
    });

    it('applies the cursor on later pages only', async () => {
      queryRunner.query.mockResolvedValueOnce(undefined);
      queryRunner.query.mockResolvedValueOnce([]);
      await service.enumerate(liveSegment, 'user-1', 500);

      const [sql, params] = queryRunner.query.mock.calls[1];
      expect(sql).toContain('person_key >');
      expect(params).toContain('user-1');
    });

    it('sets a statement timeout inside a transaction', async () => {
      queryRunner.query.mockResolvedValueOnce(undefined);
      queryRunner.query.mockResolvedValueOnce([]);
      await service.enumerate(liveSegment, null, 500);

      expect(queryRunner.startTransaction).toHaveBeenCalled();
      expect(queryRunner.query.mock.calls[0][0]).toContain('SET LOCAL statement_timeout');
      expect(queryRunner.release).toHaveBeenCalled();
    });

    it('releases the runner and rolls back when the query fails', async () => {
      queryRunner.query.mockResolvedValueOnce(undefined);
      queryRunner.query.mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));

      await expect(service.enumerate(liveSegment, null, 500)).rejects.toThrow(/timeout/);
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
    });
  });

  describe('enumerate (materialized)', () => {
    it('reads segment_members instead of recompiling', async () => {
      memberRepo.find.mockResolvedValueOnce([{ personKey: 'user-9' }]);

      const keys = await service.enumerate(materializedSegment, null, 500);

      expect(keys).toEqual(['user-9']);
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
      expect(memberRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ order: { personKey: 'ASC' }, take: 500 }),
      );
    });

    it('refuses a segment that has never been materialized instead of returning nobody', async () => {
      // An empty set here would let a campaign report success having reached
      // no one, indistinguishable from a genuinely empty audience.
      await expect(service.enumerate(unmaterializedSegment, null, 500)).rejects.toThrow(
        /has not been materialized yet/,
      );
      expect(memberRepo.find).not.toHaveBeenCalled();
    });

    it('names the segment in the refusal so an operator can act on it', async () => {
      await expect(service.enumerate(unmaterializedSegment, null, 500)).rejects.toThrow(
        /seg-1.*Buyers/,
      );
    });
  });

  describe('isMember', () => {
    it('is a single indexed lookup for a materialized segment', async () => {
      memberRepo.findOne.mockResolvedValueOnce({ personKey: 'user-1' });

      await expect(service.isMember(materializedSegment, 'user-1')).resolves.toBe(true);
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('refuses an unmaterialized segment rather than reporting non-membership', async () => {
      await expect(service.isMember(unmaterializedSegment, 'user-1')).rejects.toThrow(
        /has not been materialized yet/,
      );
      expect(memberRepo.findOne).not.toHaveBeenCalled();
    });

    it('narrows the compiled SQL to one person for a live segment', async () => {
      queryRunner.query.mockResolvedValueOnce(undefined);
      queryRunner.query.mockResolvedValueOnce([{ person_key: 'user-1' }]);

      await expect(service.isMember(liveSegment, 'user-1')).resolves.toBe(true);

      const [sql, params] = queryRunner.query.mock.calls[1];
      expect(sql).toContain('person_key = ');
      expect(sql).toContain('LIMIT 1');
      expect(params).toContain('user-1');
    });

    it('returns false when nothing matches', async () => {
      queryRunner.query.mockResolvedValueOnce(undefined);
      queryRunner.query.mockResolvedValueOnce([]);
      await expect(service.isMember(liveSegment, 'nobody')).resolves.toBe(false);
    });
  });

  describe('countFor', () => {
    it('counts the wrapped subquery under the preview timeout', async () => {
      queryRunner.query.mockResolvedValueOnce(undefined);
      queryRunner.query.mockResolvedValueOnce([{ count: '42' }]);

      await expect(
        service.countFor(liveSegment.definition, 'proj-1'),
      ).resolves.toBe(42);

      expect(queryRunner.query.mock.calls[0][0]).toContain('5000');
      expect(queryRunner.query.mock.calls[1][0]).toContain('count(*)');
    });
  });

  describe('resolveDeviceIdentityIds', () => {
    it('splits device keys from external user ids', async () => {
      queryRunner.query.mockResolvedValueOnce(undefined);
      queryRunner.query.mockResolvedValueOnce([{ id: 'dev-1' }, { id: 'dev-2' }]);

      const ids = await service.resolveDeviceIdentityIds('proj-1', [
        'user-1',
        'device:aaaaaaaa-0000-0000-0000-000000000003',
      ]);

      const [, params] = queryRunner.query.mock.calls[1];
      expect(params[1]).toEqual(['user-1']);
      expect(params[2]).toEqual(['aaaaaaaa-0000-0000-0000-000000000003']);
      expect(ids).toEqual(['dev-1', 'dev-2']);
    });

    it('returns nothing for an empty key list without querying', async () => {
      await expect(service.resolveDeviceIdentityIds('proj-1', [])).resolves.toEqual([]);
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });
  });
});
