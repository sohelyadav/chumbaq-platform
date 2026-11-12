import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from './entities/user.entity';
import { UsersService } from './users.service';

/**
 * `UsersService` with no controllers, for the admin API: Nest serves the controllers of
 * every module an app imports, so a module the admin app imports must not declare
 * customer routes. `UsersModule` adds the customer controller on top of this.
 */
@Module({
  imports: [TypeOrmModule.forFeature([UserEntity])],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersCoreModule {}
