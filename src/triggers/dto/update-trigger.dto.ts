import { ApiPropertyOptional } from '@nestjs/swagger';
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

/** FR-CFG-04. Partial update — same fields as CreateTriggerDto, all optional. */
export class UpdateTriggerDto {
  @ApiPropertyOptional({ example: 'Pricing page nudge' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name?: string;

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

  @ApiPropertyOptional({ type: [ConditionDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ConditionDto)
  conditions?: ConditionDto[];

  @ApiPropertyOptional({ type: [ActionDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ActionDto)
  actions?: ActionDto[];

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  fireOncePerVisitor?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsInt()
  priority?: number;
}
