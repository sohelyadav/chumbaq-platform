import { Transform, TransformFnParams } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import type {
  AdminSortOrder,
  AdminTenantActivity,
  AdminTenantSort,
  AdminTenantStatus,
  FactorResetVerificationMethod,
} from '@chumbaq/shared';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import {
  FACTOR_RESET_VERIFICATION_METHODS,
  VERIFICATION_NOTES_MAX,
  VERIFICATION_NOTES_MIN,
} from '../../factor-resets/entities/factor-reset.entity';
import {
  RECENT_RESET_JUSTIFICATION_MAX,
  RECENT_RESET_JUSTIFICATION_MIN,
} from '../../factor-resets/password-reset-window';

export const ADMIN_TENANT_STATUSES: AdminTenantStatus[] = ['active', 'suspended'];

// Records rather than arrays: shared exports only the types, and this way a value
// added there fails compilation here instead of being refused with a 400.
const TENANT_ACTIVITIES: Record<AdminTenantActivity, true> = { new: true, quiet: true, never_used: true };
const TENANT_SORTS: Record<AdminTenantSort, true> = {
  created_at: true,
  mau_this_month: true,
  messages_sent_30d: true,
  last_usage_day: true,
};
const SORT_ORDERS: Record<AdminSortOrder, true> = { asc: true, desc: true };

export const ADMIN_TENANT_ACTIVITIES = Object.keys(TENANT_ACTIVITIES) as AdminTenantActivity[];
export const ADMIN_TENANT_SORTS = Object.keys(TENANT_SORTS) as AdminTenantSort[];
export const ADMIN_SORT_ORDERS = Object.keys(SORT_ORDERS) as AdminSortOrder[];

/**
 * Reads the raw input, because `enableImplicitConversion` has already turned an
 * object into the string "[object Object]" by the time `value` gets here, and
 * that would pass as a 15-character reason.
 */
function trimRawString({ key, obj }: TransformFnParams): unknown {
  const raw = obj[key];
  return typeof raw === 'string' ? raw.trim() : raw;
}

// The constructor signature TypeScript requires of a mixin's base.
type Constructor = new (...args: any[]) => object;

/** The filters and sort, shared by the paged list and the export so the two cannot drift. */
function withTenantFilters<TBase extends Constructor>(Base: TBase) {
  class TenantFilters extends Base {
    @IsOptional()
    @Transform(trimRawString)
    @IsString()
    @MaxLength(255)
    @Matches(/^[^\0]*$/, { message: '$property must not contain null characters' })
    search?: string;

    @IsOptional()
    @IsIn(ADMIN_TENANT_STATUSES)
    status?: AdminTenantStatus;

    /** Overlapping usage filters: signed up lately, gone quiet, never used. */
    @IsOptional()
    @IsIn(ADMIN_TENANT_ACTIVITIES)
    activity?: AdminTenantActivity;

    /** The effective plan's code; `free` is every account while billing is off. */
    @IsOptional()
    @IsString()
    @Matches(/^[a-z][a-z0-9_]{1,31}$/, { message: 'plan must be a plan code' })
    plan?: string;

    @IsIn(ADMIN_TENANT_SORTS)
    sort: AdminTenantSort = 'created_at';

    @IsIn(ADMIN_SORT_ORDERS)
    order: AdminSortOrder = 'desc';
  }
  return TenantFilters;
}

export class ListAdminTenantsDto extends withTenantFilters(PaginationDto) {}

/** The export: the list's filters and sort, unpaged. */
export class AdminTenantsFilterDto extends withTenantFilters(class {}) {}

export class AdminTenantReasonDto {
  @Transform(trimRawString)
  @IsString()
  @Length(10, 500)
  @Matches(/^[^\0]*$/, { message: '$property must not contain null characters' })
  reason: string;
}

/**
 * Starting a factor reset. `recentResetJustification` is apart from the reason so that a
 * request soon after a password reset has to say, on its own, why that reset does not
 * matter: the reason alone tends to be the same "verified by video call" either way.
 */
export class AdminFactorResetRequestDto extends AdminTenantReasonDto {
  /** How the person was verified, by some means other than the account's email. */
  @IsIn([...FACTOR_RESET_VERIFICATION_METHODS])
  verificationMethod: FactorResetVerificationMethod;

  /** What staff saw, in their own words: which ID, which number they called back. */
  @Transform(trimRawString)
  @IsString()
  @Length(VERIFICATION_NOTES_MIN, VERIFICATION_NOTES_MAX)
  @Matches(/^[^\0]*$/, { message: '$property must not contain null characters' })
  verificationNotes: string;

  @IsOptional()
  @Transform(trimRawString)
  @IsString()
  // The same bounds as the CLI's --recent-reset-justification, so neither is the easier way.
  @Length(RECENT_RESET_JUSTIFICATION_MIN, RECENT_RESET_JUSTIFICATION_MAX)
  @Matches(/^[^\0]*$/, { message: '$property must not contain null characters' })
  recentResetJustification?: string;
}

/** Generous, but a typo of 10000 should not turn the limit off. */
export const PROJECT_LIMIT_MAX = 1000;

export const SEAT_LIMIT_MAX = 1000;

/** Setting an account's own project limit; null returns it to the default. */
export class AdminProjectLimitDto extends AdminTenantReasonDto {
  // Present and null clears the override; absent is refused, so a body that forgot
  // the field cannot quietly clear it.
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(PROJECT_LIMIT_MAX)
  projectLimit: number | null;
}

/** Setting an account's own seat limit; null returns it to the default. */
export class AdminSeatLimitDto extends AdminTenantReasonDto {
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(SEAT_LIMIT_MAX)
  seatLimit: number | null;
}
