import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

import {
  TRIGGER_CONDITION_LOGICS,
  TRIGGER_RUN_EVENTS,
} from '../../database/schemas/trigger.schema';
import type {
  TriggerConditionLogic,
  TriggerRunEvent,
} from '../../database/schemas/trigger.schema';
import { ActionDto, ConditionDto } from './condition-action.dto';

/**
 * FR-CFG-04/05 — rebuilt this session into a real condition/action
 * builder (see trigger.schema.ts's header comment for the scope
 * decision). `siteId` is never a body field — always the route's
 * `:siteId` (the one `PermissionGuard` already checked `triggers.manage`
 * against), same reasoning as `CreateUserDto`'s `initialRoleAssignment`.
 */
export class CreateTriggerDto {
  @ApiProperty({ example: 'Pricing page nudge' })
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;

  @ApiPropertyOptional({ example: 'Nudges visitors who linger on Pricing.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ example: 'widgetLoaded', enum: TRIGGER_RUN_EVENTS })
  @IsOptional()
  @IsIn(TRIGGER_RUN_EVENTS)
  runEvent?: TriggerRunEvent;

  @ApiPropertyOptional({ example: 'all', enum: TRIGGER_CONDITION_LOGICS })
  @IsOptional()
  @IsIn(TRIGGER_CONDITION_LOGICS)
  conditionLogic?: TriggerConditionLogic;

  @ApiProperty({ type: [ConditionDto] })
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ConditionDto)
  conditions!: ConditionDto[];

  @ApiProperty({ type: [ActionDto] })
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ActionDto)
  actions!: ActionDto[];

  @ApiPropertyOptional({ example: false, default: false })
  @IsOptional()
  @IsBoolean()
  fireOncePerVisitor?: boolean;

  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @ApiPropertyOptional({
    example: 10,
    description:
      'Evaluation order (FR-CFG-05): higher number = higher priority. Among ' +
      'multiple matching, enabled Triggers, the widget fires only the ' +
      'highest-priority one. Defaults to 0.',
  })
  @IsOptional()
  @IsInt()
  priority?: number;
}
