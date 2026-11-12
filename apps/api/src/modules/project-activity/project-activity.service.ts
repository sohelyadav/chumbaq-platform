import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import * as geoip from 'geoip-lite';
import type { ProjectActivityAction, ProjectActivityActorKind } from '@chumbaq/shared';
import { UserEntity } from '../users/entities/user.entity';
import { ProjectActivityEntity } from './entities/project-activity.entity';
import { ACTIVITY_DETAIL_KEYS } from './activity-details';
import type { ActivityContext } from './activity-context';

/** Who did it. A person is named from `users` at the time of writing. */
export type ActivityActor =
  | { kind: 'user'; userId: string }
  | { kind: 'staff' }
  | { kind: 'api_key'; keyId: string; keyName: string }
  | { kind: 'system' };

export interface ActivityInput {
  projectId: string;
  actor: ActivityActor;
  action: ProjectActivityAction;
  /** What was acted on, with its name at the time. */
  target?: { type: string; id?: string | null; label?: string | null };
  /** Only the keys `ACTIVITY_DETAIL_KEYS[action]` allows; anything else throws. */
  details?: Record<string, unknown>;
}

/** Labels are cut by code point, so an emoji is never split into half a surrogate pair. */
const LABEL_LIMIT = 200;
const USER_AGENT_LIMIT = 512;
const IP_LIMIT = 64;

const STAFF_LABEL = 'Chumbaq support';
const SYSTEM_LABEL = 'Chumbaq';

function cutCodePoints(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length > limit ? points.slice(0, limit).join('') : value;
}

/** How the log names a person: "Name (email)", or the address alone when they have no name. */
export function personLabel(user: { name?: string | null; email: string }): string {
  const name = user.name?.trim();
  return name ? `${name} (${user.email})` : user.email;
}

/** A person as a target (a member, or the receiver of a billing offer), named from `users` in `manager`'s snapshot. */
export async function memberTarget(
  manager: EntityManager,
  userId: string,
): Promise<{ type: 'member'; id: string; label: string }> {
  const user = await manager.findOne(UserEntity, { where: { id: userId }, select: { id: true, name: true, email: true } });
  return { type: 'member', id: userId, label: user ? personLabel(user) : userId };
}

function isPrivateAddress(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.');
}

/**
 * Writes the project activity log. Deliberately has no update or delete: the table is
 * append-only, and its trigger refuses both anyway.
 *
 * It throws rather than swallow a failure. A caller in a transaction passes its `manager`
 * so the entry and the action commit or roll back together; a caller without one writes
 * right after the change and lets the error fail the request.
 */
@Injectable()
export class ProjectActivityService {
  constructor(
    @InjectRepository(ProjectActivityEntity)
    private readonly repository: Repository<ProjectActivityEntity>,
    private readonly config: ConfigService,
  ) {}

  async record(input: ActivityInput, context: ActivityContext, manager?: EntityManager): Promise<void> {
    const em = manager ?? this.repository.manager;
    await em.getRepository(ProjectActivityEntity).insert(await this.row(input, context, em));
  }

  /**
   * Several entries in one INSERT, so they are written all together or not at all, by the
   * same rules as `record`. Every row is checked before anything is written.
   */
  async recordMany(inputs: ActivityInput[], context: ActivityContext, manager?: EntityManager): Promise<void> {
    if (inputs.length === 0) return;
    const em = manager ?? this.repository.manager;
    const rows: QueryDeepPartialEntity<ProjectActivityEntity>[] = [];
    for (const input of inputs) rows.push(await this.row(input, context, em));
    await em.getRepository(ProjectActivityEntity).insert(rows);
  }

  private async row(
    input: ActivityInput,
    context: ActivityContext,
    em: EntityManager,
  ): Promise<QueryDeepPartialEntity<ProjectActivityEntity>> {
    const details = this.checkedDetails(input.action, input.details);
    const actor = await this.resolveActor(input.actor, em);
    const ipAddress = context.ipAddress ? context.ipAddress.slice(0, IP_LIMIT) : null;

    return {
      projectId: input.projectId,
      actorKind: actor.kind,
      actorUserId: actor.userId,
      actorLabel: cutCodePoints(actor.label, LABEL_LIMIT),
      action: input.action,
      targetType: input.target?.type ?? null,
      targetId: input.target?.id ?? null,
      targetLabel: input.target?.label != null ? cutCodePoints(input.target.label, LABEL_LIMIT) : null,
      // TypeORM's partial type can't express an open jsonb record; the value is checked above.
      details: details as QueryDeepPartialEntity<Record<string, unknown>> | null,
      ipAddress,
      userAgent: context.userAgent ? context.userAgent.slice(0, USER_AGENT_LIMIT) : null,
      country: this.country(ipAddress),
    };
  }

  /** The allow-list is the only thing between a careless caller's DTO and the log. */
  private checkedDetails(
    action: ProjectActivityAction,
    details: Record<string, unknown> | undefined,
  ): Record<string, unknown> | null {
    const allowed = Object.prototype.hasOwnProperty.call(ACTIVITY_DETAIL_KEYS, action)
      ? ACTIVITY_DETAIL_KEYS[action]
      : undefined;
    if (!allowed) throw new Error(`"${action}" is not a known activity action`);
    if (!details) return null;
    const keys = Object.keys(details);
    for (const key of keys) {
      if (!allowed.includes(key)) {
        throw new Error(`Activity detail "${key}" is not allowed for ${action}`);
      }
    }
    return keys.length > 0 ? details : null;
  }

  private async resolveActor(
    actor: ActivityActor,
    em: EntityManager,
  ): Promise<{ kind: ProjectActivityActorKind; userId: string | null; label: string }> {
    switch (actor.kind) {
      case 'user': {
        const user = await em.findOne(UserEntity, {
          where: { id: actor.userId },
          select: { id: true, name: true, email: true },
        });
        if (!user) throw new Error(`Activity actor ${actor.userId} not found`);
        return { kind: 'user', userId: actor.userId, label: personLabel(user) };
      }
      case 'staff':
        return { kind: 'staff', userId: null, label: STAFF_LABEL };
      case 'api_key':
        return { kind: 'api_key', userId: null, label: `API key "${actor.keyName}"` };
      case 'system':
        return { kind: 'system', userId: null, label: SYSTEM_LABEL };
    }
  }

  /** Only when geo lookup is on, as for every other lookup in the API. */
  private country(ip: string | null): string | null {
    if (!ip || isPrivateAddress(ip) || !this.config.get<boolean>('app.geoipEnabled')) return null;
    try {
      return geoip.lookup(ip)?.country || null;
    } catch {
      return null;
    }
  }
}
