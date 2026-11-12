import { IsString, IsOptional, IsBoolean, IsInt, IsObject, IsIn, MaxLength, Min } from 'class-validator';
import { themeColour } from '../../../common/theme-colour';

export class UpdateBannerCategoryDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @IsIn(['carousel', 'grid', 'single', 'stories', 'swipe_strip'])
  layout?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  aspectRatio?: string;

  @IsOptional()
  @IsBoolean()
  autoRotate?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  rotationInterval?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  heading?: string;

  /**
   * The widget's background, applied by the SDK to a real style property.
   * Pattern-validated for the same reason a message theme is — see
   * `themeColour`. The limit matches the column, which
   * `WidenBannerBackgroundColor` widened to 32 precisely so that a valid
   * spaced `rgba(255, 255, 255, 0.5)` — 24 characters — is not refused.
   */
  @IsOptional()
  @themeColour()
  @MaxLength(32)
  backgroundColor?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  padding?: number;

  @IsOptional()
  @IsObject()
  config?: Record<string, any>;

  @IsOptional()
  @IsString()
  @IsIn(['draft', 'active', 'paused'])
  status?: string;
}
