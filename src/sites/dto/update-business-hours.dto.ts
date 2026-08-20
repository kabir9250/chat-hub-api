import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * FR-CFG-03. `weeklySchedule` is kept loose here (schema-level it's
 * `Record<string, string[]>`, per `BusinessHoursConfig`) — `class-validator`
 * can't cheaply express "keys are weekday abbreviations, values are
 * HH:MM-HH:MM ranges" as decorators, so `BusinessHoursService` validates its
 * shape at the service layer (same pattern `RolesService.validateCatalogKeys`
 * uses for `permissions[]`).
 */
export class UpdateBusinessHoursDto {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ example: 'America/New_York' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  timezone?: string;

  @ApiPropertyOptional({
    description:
      'Keys are mon/tue/wed/thu/fri/sat/sun; values are 24h "HH:MM-HH:MM" ranges.',
    example: {
      mon: ['09:00-17:00'],
      tue: ['09:00-17:00'],
      wed: ['09:00-17:00'],
      thu: ['09:00-17:00'],
      fri: ['09:00-17:00'],
    },
  })
  @IsOptional()
  @IsObject()
  weeklySchedule?: Record<string, string[]>;
}
