import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsMongoId,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * FR-CONV-01 / FR-RTE-01. Visitor-facing (behind `VisitorAuthGuard`, not
 * `PermissionGuard`) — starting a chat is inherently something the Visitor
 * does, not an Agent/Admin action. `visitorId` and `siteId` are deliberately
 * NOT body fields: both come from the caller's verified Visitor session
 * token (see VisitorAuthGuard), so a caller can never create a Conversation
 * "as" a different Visitor or on a different Site than the one their token
 * was issued for — same reasoning as `CreateUserDto.initialRoleAssignment`
 * never taking a body `siteId`.
 */
export class CreateConversationDto {
  @ApiPropertyOptional({
    example: '507f1f77bcf86cd799439021',
    description:
      "A Department on the visitor's Site. Omit to use that Site's Department " +
      '(Phase 1: "effectively one department per Site," per the SRS glossary).',
  })
  @IsOptional()
  @IsMongoId()
  departmentId?: string;

  @ApiPropertyOptional({
    example: 'Hi, I have a question about pricing.',
    description:
      "Optional — if given, persisted as the Visitor's first Message on the " +
      'new Conversation (convenience for REST testing; real-time send is Session 8).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  initialMessage?: string;

  @ApiPropertyOptional({
    example: ['pricing-page'],
    description:
      "Initial tags — e.g. a matched Trigger's addTag action (FR-CFG-04/05).",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];

  // FR-CFG-01/02 Forms builder (this session's addition) — answers to any
  // custom (non-builtin) field an admin added to the offline form, keyed by
  // that field's `FormFieldConfig.id`. The builtin `message` field is still
  // `initialMessage` above, not part of this map.
  @ApiPropertyOptional({
    example: { orderNumber: '#10234' },
    description: "Answers to any custom fields on the Site's offline form.",
  })
  @IsOptional()
  @IsObject()
  customFields?: Record<string, string>;
}
