import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SegmentEntity } from './entities/segment.entity';
import { SegmentMemberEntity } from './entities/segment-member.entity';
import { SegmentEvaluationService } from './segment-evaluation.service';
import { SegmentAstError, SegmentNode, validateAst } from './segment-ast';
import { CreateSegmentDto, UpdateSegmentDto } from './dto/segment.dto';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { contentDeleted, recordBy, type ActivityRequester } from '../project-activity/messaging-activity';

@Injectable()
export class SegmentsService {
  constructor(
    @InjectRepository(SegmentEntity)
    private readonly segmentRepository: Repository<SegmentEntity>,
    @InjectRepository(SegmentMemberEntity)
    private readonly memberRepository: Repository<SegmentMemberEntity>,
    private readonly evaluation: SegmentEvaluationService,
    private readonly activity: ProjectActivityService,
  ) {}

  /**
   * The single write-side gate. Converts an AST error into a 400 carrying the
   * offending node path, so a builder can highlight one rule rather than
   * saying "invalid segment".
   */
  private assertValid(ast: SegmentNode): void {
    try {
      validateAst(ast);
    } catch (error) {
      if (error instanceof SegmentAstError) {
        throw new BadRequestException(`${error.path}: ${error.message}`);
      }
      throw error;
    }
  }

  /** Behavioural segments are expensive to evaluate live, so they default to materialised. */
  private containsBehaviour(node: SegmentNode): boolean {
    if (node.type === 'behaviour') return true;
    if (node.type === 'group') return node.children.some((c) => this.containsBehaviour(c));
    return false;
  }

  async create(projectId: string, dto: CreateSegmentDto): Promise<SegmentEntity> {
    this.assertValid(dto.definition);

    const segment = this.segmentRepository.create({
      projectId,
      name: dto.name,
      description: dto.description ?? null,
      definition: dto.definition,
      evaluationMode:
        dto.evaluationMode ??
        (this.containsBehaviour(dto.definition) ? 'materialized' : 'live'),
      refreshIntervalMinutes: dto.refreshIntervalMinutes ?? 60,
      status: dto.status ?? 'draft',
    } as Partial<SegmentEntity>);

    return this.segmentRepository.save(segment as SegmentEntity);
  }

  async findAll(projectId: string): Promise<SegmentEntity[]> {
    return this.segmentRepository.find({
      where: { projectId },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(projectId: string, id: string): Promise<SegmentEntity> {
    const segment = await this.segmentRepository.findOne({ where: { id, projectId } });
    if (!segment) throw new NotFoundException(`Segment ${id} not found`);
    return segment;
  }

  async update(projectId: string, id: string, dto: UpdateSegmentDto): Promise<SegmentEntity> {
    const segment = await this.findOne(projectId, id);

    // Tracked from the branch that actually replaces the definition, not from
    // `dto.definition !== undefined`: the field is @IsOptional, so an explicit
    // null passes validation, and keying off presence alone would wipe the
    // membership of a segment whose definition never changed.
    let definitionChanged = false;
    if (dto.definition) {
      this.assertValid(dto.definition);
      definitionChanged = true;
      segment.definition = dto.definition;
      // The previous membership was computed from a different question.
      segment.lastMaterializedAt = null;
      segment.lastMemberCount = null;
    }

    if (dto.name !== undefined) segment.name = dto.name;
    if (dto.description !== undefined) segment.description = dto.description;
    if (dto.evaluationMode !== undefined) segment.evaluationMode = dto.evaluationMode;
    if (dto.refreshIntervalMinutes !== undefined) {
      segment.refreshIntervalMinutes = dto.refreshIntervalMinutes;
    }
    if (dto.status !== undefined) {
      segment.status = dto.status;
      segment.errorMessage = null;
    }

    const saved = await this.segmentRepository.save(segment);

    // Clearing the timestamps is not enough on its own: segment_members still
    // holds rows answering the old question, and a send between this edit and
    // the next materialisation run would go to that stale audience. Deleting
    // them leaves lastMaterializedAt null and the rows gone, which
    // enumerate() and isMember() now treat as "no valid membership yet" and
    // refuse rather than quietly resolving to nobody.
    if (definitionChanged) {
      await this.memberRepository.delete({ segmentId: segment.id });
    }

    return saved;
  }

  async remove(projectId: string, id: string, requester: ActivityRequester): Promise<void> {
    const segment = await this.findOne(projectId, id);
    const entry = contentDeleted(projectId, 'segment', { id: segment.id, name: segment.name });
    await this.segmentRepository.manager.transaction(async (manager) => {
      // Only the request whose DELETE removed the row writes the entry.
      const result = await manager.getRepository(SegmentEntity).delete({ id: segment.id, projectId });
      if (!result.affected) throw new NotFoundException(`Segment ${id} not found`);
      await recordBy(this.activity, requester, entry, manager);
    });
  }

  /** Count for an unsaved AST — what the future builder calls as rules change. */
  async preview(projectId: string, ast: SegmentNode): Promise<{ count: number }> {
    this.assertValid(ast);
    return { count: await this.evaluation.countFor(ast, projectId) };
  }

  async listMembers(
    projectId: string,
    id: string,
    afterKey: string | null,
    limit: number,
  ): Promise<{ personKeys: string[]; nextCursor: string | null }> {
    const segment = await this.findOne(projectId, id);
    const personKeys = await this.evaluation.enumerate(segment, afterKey, limit);
    return {
      personKeys,
      nextCursor: personKeys.length === limit ? personKeys[personKeys.length - 1] : null,
    };
  }
}
