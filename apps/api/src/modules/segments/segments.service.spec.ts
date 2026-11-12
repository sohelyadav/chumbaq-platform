import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SegmentsService } from './segments.service';
import { SegmentEntity } from './entities/segment.entity';
import { SegmentMemberEntity } from './entities/segment-member.entity';
import { SegmentEvaluationService } from './segment-evaluation.service';
import { SegmentNode } from './segment-ast';
import { ProjectActivityService } from '../project-activity/project-activity.service';

const activity = { record: jest.fn() };

describe('SegmentsService', () => {
  let service: SegmentsService;

  const repo = {
    create: jest.fn(), save: jest.fn(), find: jest.fn(),
    findOne: jest.fn(), delete: jest.fn(),
  };
  const memberRepo = { delete: jest.fn() };
  const evaluation = { countFor: jest.fn(), enumerate: jest.fn() };

  const attributeAst = {
    type: 'attribute', field: 'country', op: 'eq', value: 'US',
  } as SegmentNode;

  const behaviourAst = {
    type: 'behaviour', eventName: 'purchase',
    occurrence: 'at_least', count: 1, withinDays: 7,
  } as SegmentNode;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: ProjectActivityService, useValue: activity },
        SegmentsService,
        { provide: getRepositoryToken(SegmentEntity), useValue: repo },
        { provide: getRepositoryToken(SegmentMemberEntity), useValue: memberRepo },
        { provide: SegmentEvaluationService, useValue: evaluation },
      ],
    }).compile();
    service = module.get(SegmentsService);
  });

  describe('create', () => {
    it('rejects an invalid AST with the offending node path', async () => {
      await expect(
        service.create('proj-1', {
          name: 'bad',
          definition: { type: 'attribute', field: 'password', op: 'eq', value: 'x' } as SegmentNode,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(repo.save).not.toHaveBeenCalled();
    });

    it('includes the node path in the error message', async () => {
      try {
        await service.create('proj-1', {
          name: 'bad',
          definition: {
            type: 'group', operator: 'and',
            children: [{ type: 'attribute', field: 'nope', op: 'eq', value: 'x' }],
          } as SegmentNode,
        });
        throw new Error('expected create to throw');
      } catch (e) {
        expect((e as BadRequestException).message).toContain('root.children[0]');
      }
    });

    it('defaults an attribute-only segment to live', async () => {
      repo.create.mockImplementation((o) => o);
      repo.save.mockImplementation(async (o) => ({ id: 'seg-1', ...o }));

      await service.create('proj-1', { name: 'ok', definition: attributeAst });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ evaluationMode: 'live' }),
      );
    });

    it('defaults a behavioural segment to materialized', async () => {
      repo.create.mockImplementation((o) => o);
      repo.save.mockImplementation(async (o) => ({ id: 'seg-1', ...o }));

      await service.create('proj-1', { name: 'ok', definition: behaviourAst });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ evaluationMode: 'materialized' }),
      );
    });

    it('honours an explicit evaluationMode override', async () => {
      repo.create.mockImplementation((o) => o);
      repo.save.mockImplementation(async (o) => ({ id: 'seg-1', ...o }));

      await service.create('proj-1', {
        name: 'ok', definition: behaviourAst, evaluationMode: 'live',
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ evaluationMode: 'live' }),
      );
    });
  });

  describe('update', () => {
    it('revalidates a replaced definition', async () => {
      repo.findOne.mockResolvedValueOnce({ id: 'seg-1', projectId: 'proj-1' });

      await expect(
        service.update('proj-1', 'seg-1', {
          definition: { type: 'attribute', field: 'nope', op: 'eq', value: 'x' } as SegmentNode,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFound for a segment in another project', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      await expect(service.update('proj-1', 'seg-x', { name: 'y' }))
        .rejects.toThrow(NotFoundException);
    });

    it('drops the stale membership when the definition changes', async () => {
      repo.findOne.mockResolvedValueOnce({
        id: 'seg-1', projectId: 'proj-1',
        lastMaterializedAt: new Date(), lastMemberCount: 900,
      });
      repo.save.mockImplementation(async (o) => o);

      const saved = await service.update('proj-1', 'seg-1', { definition: behaviourAst });

      // Clearing the timestamps alone left segment_members answering the old
      // question, so an immediate send went to the previous audience.
      expect(memberRepo.delete).toHaveBeenCalledWith({ segmentId: 'seg-1' });
      expect(saved.lastMaterializedAt).toBeNull();
      expect(saved.lastMemberCount).toBeNull();
    });

    it('leaves the membership alone when only metadata changes', async () => {
      repo.findOne.mockResolvedValueOnce({
        id: 'seg-1', projectId: 'proj-1', lastMaterializedAt: new Date(),
      });
      repo.save.mockImplementation(async (o) => o);

      await service.update('proj-1', 'seg-1', { name: 'Renamed' });

      expect(memberRepo.delete).not.toHaveBeenCalled();
    });

    it('does not wipe membership for an explicit null definition', async () => {
      // definition is @IsOptional, so null clears validation. Keying the purge
      // off presence rather than off the branch that replaces the definition
      // would destroy a valid audience here.
      repo.findOne.mockResolvedValueOnce({ id: 'seg-1', projectId: 'proj-1' });
      repo.save.mockImplementation(async (o) => o);

      await service.update('proj-1', 'seg-1', {
        definition: null as unknown as SegmentNode,
      });

      expect(memberRepo.delete).not.toHaveBeenCalled();
    });

    it('does not purge when the replacement definition is rejected', async () => {
      repo.findOne.mockResolvedValueOnce({ id: 'seg-1', projectId: 'proj-1' });

      await expect(
        service.update('proj-1', 'seg-1', {
          definition: { type: 'attribute', field: 'nope', op: 'eq', value: 'x' } as SegmentNode,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(memberRepo.delete).not.toHaveBeenCalled();
    });
  });

  describe('preview', () => {
    it('validates before counting', async () => {
      await expect(
        service.preview('proj-1', { type: 'attribute', field: 'nope', op: 'eq', value: 1 } as SegmentNode),
      ).rejects.toThrow(BadRequestException);
      expect(evaluation.countFor).not.toHaveBeenCalled();
    });

    it('returns the count for a valid AST', async () => {
      evaluation.countFor.mockResolvedValueOnce(42);
      await expect(service.preview('proj-1', attributeAst)).resolves.toEqual({ count: 42 });
    });
  });
});
