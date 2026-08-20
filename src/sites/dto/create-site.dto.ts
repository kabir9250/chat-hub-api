import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * `sites.manage`. A brand-new Site always starts `chatEnabled: false`
 * regardless of `domains` here — see `SitesService.create`'s doc comment —
 * so there's no `chatEnabled` field on this DTO; that's only ever flipped
 * via `UpdateSiteDto`.
 */
export class CreateSiteDto {
  @ApiProperty({ example: 'Brand Site 5' })
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['example.com'],
    description:
      "The Site's URL(s) — what the embed script/widget is allowed to run " +
      'on. Optional at create time (a Site can be created before its URL ' +
      'is known), but required before `chatEnabled` can be turned on.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  domains?: string[];

  @ApiPropertyOptional({ example: 'UTC' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  timezone?: string;
}
