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

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly events: AuthEventsService,
    private readonly notices: SecurityNoticesService,
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

    const isPasswordValid = await bcrypt.compare(
      dto.currentPassword,
      user.passwordHash,
    );
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid current password');
    }

    const newPasswordHash = await bcrypt.hash(dto.newPassword, 12);
    await this.usersService.changeOwnPassword(userId, newPasswordHash);
    await this.events.record({
      type: 'password.changed',
      userId,
      email: user.email,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });
    this.notices.passwordChangedByOwner(user);

    return { message: 'Password updated successfully' };
  }
}
