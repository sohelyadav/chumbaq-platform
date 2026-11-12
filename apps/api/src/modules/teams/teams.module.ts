import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TeamEntity } from './entities/team.entity';
import { TeamMemberEntity } from './entities/team-member.entity';

/**
 * The old teams feature has no routes any more; only the tables are kept, so accounts a
 * team created (and `users.managed_by_team_id`) stay as they were. See the team-roles spec,
 * "The old teams feature".
 */
@Module({
  imports: [TypeOrmModule.forFeature([TeamEntity, TeamMemberEntity])],
})
export class TeamsModule {}
