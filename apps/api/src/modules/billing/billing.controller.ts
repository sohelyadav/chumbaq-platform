import { Body, Controller, Get, NotFoundException, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { BillingCheckout, BillingDetails, BillingInvoiceView, BillingOverview } from '@chumbaq/shared';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RecentAuthGuard } from '../auth/guards/recent-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { refuseViewAs } from '../project-access/view-as';
import { UsersService } from '../users/users.service';
import { BillingCheckoutService } from './billing-checkout.service';
import { BillingEnabledGuard } from './billing-enabled.guard';
import { BillingOverviewService } from './billing-overview.service';
import { BillingDetailsDto, ChoosePlanDto } from './dto/billing.dto';

/**
 * The caller's own billing account: the tenant whose projects are billed to them. No
 * project is named, so no project permission applies; every route acts on the caller
 * alone, and the account owns billing, not any one project.
 *
 * `BillingEnabledGuard` runs first, so while billing is off every route is a plain
 * 404, before authentication. View-as is refused on every route, reads included:
 * staff see billing in the admin app. Writes that commit money or end a plan need a
 * recent sign-in. Bodies carry a plan and an interval only; the price is always the
 * server's (an extra field such as an amount is a 400 from the global pipe).
 */
@Controller('billing')
@UseGuards(BillingEnabledGuard, JwtAuthGuard)
export class BillingController {
  constructor(
    private readonly overviews: BillingOverviewService,
    private readonly checkout: BillingCheckoutService,
    private readonly users: UsersService,
  ) {}

  @Get()
  overview(@CurrentUser() user: AuthenticatedUser): Promise<BillingOverview> {
    refuseViewAs(user);
    return this.overviews.overview(user.userId);
  }

  @Put('details')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  details(@CurrentUser() user: AuthenticatedUser, @Body() dto: BillingDetailsDto): Promise<BillingDetails> {
    refuseViewAs(user);
    return this.checkout.saveDetails(user.userId, dto);
  }

  @Post('subscribe')
  @UseGuards(RecentAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async subscribe(@CurrentUser() user: AuthenticatedUser, @Body() dto: ChoosePlanDto): Promise<BillingCheckout> {
    refuseViewAs(user);
    return this.checkout.subscribe(await this.customer(user), dto);
  }

  @Post('change')
  @UseGuards(RecentAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async change(@CurrentUser() user: AuthenticatedUser, @Body() dto: ChoosePlanDto): Promise<BillingCheckout> {
    refuseViewAs(user);
    return this.checkout.change(await this.customer(user), dto);
  }

  @Post('cancel')
  @UseGuards(RecentAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  cancel(@CurrentUser() user: AuthenticatedUser): Promise<BillingOverview> {
    refuseViewAs(user);
    return this.checkout.cancel(user.userId);
  }

  @Get('invoices')
  invoices(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationDto,
  ): Promise<{ data: BillingInvoiceView[]; meta: { total: number; page: number; limit: number } }> {
    refuseViewAs(user);
    return this.overviews.invoices(user.userId, query.page, query.limit);
  }

  /** The stored name and address, not the token's copy, which predates any change. */
  private async customer(user: AuthenticatedUser): Promise<{ userId: string; email: string; name: string }> {
    const row = await this.users.findById(user.userId);
    // JwtStrategy loaded this row a moment ago; gone now means deleted meanwhile.
    if (!row) throw new NotFoundException();
    return { userId: row.id, email: row.email, name: row.name };
  }
}
