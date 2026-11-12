import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  IsObject,
  IsArray,
  IsDateString,
  IsIn,
  IsUrl,
  MaxLength,
  Max,
  Min,
  ValidateNested,
  IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';
import { themeColour } from '../../../common/theme-colour';
import {
  MessageType,
  TriggerType,
  UserType,
  ImagePosition,
  AnimationType,
  MessageButton,
  ButtonAction,
  ButtonStyle,
  MessageTheme,
  TriggerCondition,
  UserFilters,
} from '../entities/in-app-message.entity';

/**
 * One button on an in-app message.
 *
 * A class rather than the `MessageButton` interface because the global pipe
 * runs with `enableImplicitConversion`, which coerces each element of an
 * undeclared object array into an array. Without this every message's buttons
 * were stored as `[[]]` and rendered as blank chrome with no text and no
 * action.
 */
export class MessageButtonDto {
  @IsString()
  @MaxLength(64)
  id: string;

  @IsString()
  @MaxLength(64)
  text: string;

  @IsIn(['dismiss', 'deep_link', 'url', 'custom_event'])
  action: ButtonAction;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  actionUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  actionEvent?: string;

  @IsIn(['primary', 'secondary', 'text'])
  style: ButtonStyle;
}

/**
 * A message's appearance.
 *
 * A real nested DTO rather than a bare `@IsObject()`, which accepted any
 * shape at all — any key, any type — and let an arbitrary string through to
 * every client that renders one of these fields. See `themeColour` for what
 * that bought on the web.
 */
export class MessageThemeDto {
  @IsOptional()
  @themeColour()
  backgroundColor?: string;

  @IsOptional()
  @themeColour()
  textColor?: string;

  @IsOptional()
  @themeColour()
  titleColor?: string;

  @IsOptional()
  @themeColour()
  buttonPrimaryColor?: string;

  @IsOptional()
  @themeColour()
  buttonSecondaryColor?: string;

  @IsOptional()
  @themeColour()
  overlayColor?: string;

  /** Rendered as `${borderRadius}px`; bounded because past ~100 it is not a card. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  borderRadius?: number;

  @IsOptional()
  @IsIn(['fade', 'slide_up', 'slide_down', 'scale', 'none'])
  animation?: AnimationType;
}

export class CreateInAppMessageDto {
  @IsString()
  @MaxLength(255)
  name: string;

  @IsIn(['modal', 'bottom_sheet', 'banner_top', 'banner_bottom', 'fullscreen'])
  messageType: MessageType;

  @IsString()
  @MaxLength(255)
  title: string;

  @IsOptional()
  @IsString()
  body?: string;

  /**
   * An http(s) URL, not any string. It lands in attribute position in every
   * client that renders one of these, so `" onerror="…` was a working script
   * injection and a `javascript:` scheme was a working link.
   */
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  imageUrl?: string;

  @IsOptional()
  @IsIn(['top', 'center', 'background'])
  imagePosition?: ImagePosition;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MessageButtonDto)
  buttons?: MessageButton[];

  @IsOptional()
  @ValidateNested()
  @Type(() => MessageThemeDto)
  theme?: MessageTheme;

  @IsOptional()
  @IsBoolean()
  dismissOnTapOutside?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  autoDismissSeconds?: number;

  @IsOptional()
  @IsIn(['immediate', 'on_event', 'on_screen', 'on_app_open', 'scheduled'])
  triggerType?: TriggerType;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  triggerEvent?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  triggerScreen?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  triggerDelaySeconds?: number;

  @IsOptional()
  @IsObject()
  triggerConditions?: TriggerCondition;

  @IsOptional()
  @IsIn(['all', 'cohort', 'segment', 'specific_users'])
  userType?: UserType;

  @IsOptional()
  @IsUUID()
  mixpanelCohortId?: string;

  /** Audience for userType 'segment'. Read by MessageDeliveryService. */
  @IsOptional()
  @IsUUID()
  segmentId?: string;

  @IsOptional()
  @IsObject()
  userFilters?: UserFilters;

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxImpressionsPerUser?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  minIntervalSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxImpressionsTotal?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}
