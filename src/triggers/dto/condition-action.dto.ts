import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import {
  TRIGGER_ACTION_TYPES,
  TRIGGER_CONDITION_TYPES,
} from '../../database/schemas/trigger.schema';
import type {
  TriggerActionType,
  TriggerConditionType,
} from '../../database/schemas/trigger.schema';

/**
 * One row of "Check conditions" (FR-CFG-04/05, this session's trigger
 * builder rebuild). `operator`/`value` are loosely typed here (plain
 * strings) — which operators are valid for a given `type` (e.g. `url`
 * only accepts TRIGGER_URL_OPERATORS, count-based types only accept
 * `gte`) is enforced by `TriggersService.assertValidConditions`, the same
 * "cross-field checks live in the service" pattern
 * `WidgetConfigService.assertValidFormFields` already uses.
 */
export class ConditionDto {
  @ApiProperty({ example: 'url', enum: TRIGGER_CONDITION_TYPES })
  @IsIn(TRIGGER_CONDITION_TYPES)
  type!: TriggerConditionType;

  @ApiProperty({ example: 'path prefix' })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  operator!: string;

  @ApiProperty({ example: '/pricing' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  value!: string;
}

/** One row of "Perform the following actions". */
export class ActionDto {
  @ApiProperty({ example: 'showProactiveMessage', enum: TRIGGER_ACTION_TYPES })
  @IsIn(TRIGGER_ACTION_TYPES)
  type!: TriggerActionType;

  @ApiPropertyOptional({
    example: 'Questions about pricing? I can help!',
    description:
      'Message text for showProactiveMessage/sendConciergeMessage, a ' +
      'departmentId for setDepartment/setVisitorDepartment, a tag string ' +
      'for addTag/removeTag, the new name for setVisitorName, note text ' +
      'for replaceNote/appendNote, whole seconds for wait, or an optional ' +
      'ban reason for blockVisitor. Unused by autoOpenWidget/setTriggered.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  value?: string;

  // Session Feature-2c-complex-actions — SRS §2.2's reference row for "Send
  // message to visitor" shows a distinct "from" sender-name field alongside
  // the message text ("Send message to visitor | Customer Service | <text>").
  // Only meaningful for showProactiveMessage; every other action type
  // ignores it if given.
  @ApiPropertyOptional({
    example: 'Customer Service',
    description:
      'Sender name shown alongside a showProactiveMessage bubble. Ignored ' +
      'by every other action type.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  fromName?: string;
}
