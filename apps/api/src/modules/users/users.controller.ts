import {
  Controller,
  Patch,
  Body,
  UseGuards,
  UnauthorizedException,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import * as bcrypt from 'bcrypt';
import { UsersService } from './users.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthEventsService } from '../auth-events/auth-events.service';
import { SecurityNoticesService } from '../platform-email/security-notices.service';
import { getClientIp } from '../../common/client-ip';
import { FactorResetsService } from '../factor-resets/factor-resets.service';
import { AuthService } from '../auth/auth.service';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly events: AuthEventsService,
    private readonly notices: SecurityNoticesService,
    private readonly factorResets: FactorResetsService,
    private readonly auth: AuthService,
  ) {}

  @Patch('me/password')
  async changePassword(
    @CurrentUser('userId') userId: string,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const context = { ipAddress: getClientIp(req), userAgent: req.headers['user-agent'] };
    // The current password is a guess like any other: it counts against, and is held
    // to, the same sign-in failure limit, so a stolen session cannot be used to try
    // passwords free of it.
    await this.auth.assertUnderLoginLimit(user.email, context);
    const isPasswordValid = await bcrypt.compare(
      dto.currentPassword,
      user.passwordHash,
    );
    if (!isPasswordValid) {
      await this.events.record({
        type: 'login.failed',
        userId,
        email: user.email,
        reason: 'wrong_password',
        ...context,
      });
      throw new UnauthorizedException('Invalid current password');
    }

    const newPasswordHash = await bcrypt.hash(dto.newPassword, 12);
    await this.usersService.changeOwnPassword(userId, newPasswordHash);
    await this.events.record({
      type: 'password.changed',
      userId,
      email: user.email,
      ...context,
    });
    this.notices.passwordChangedByOwner(user);
    // The owner, in a full session, just proved the password: a reset link support
    // issued in their name is now going to someone else, and would later overwrite
    // this new password. Spent as a sign-in spends it.
    const staffLinkPending = await this.factorResets.voidStaffLinksOnSignIn(user, 'password', context);

    return { message: 'Password updated successfully', ...(staffLinkPending ? { staffLinkPending } : {}) };
  }
}
