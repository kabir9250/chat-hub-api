import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * FR-WID-05: the widget's pre-chat form — Name + Email required, Phone
 * optional — submitted by the Visitor themselves (via VisitorAuthGuard),
 * before their first message can be sent. Session 6's `UpdateVisitorDto`
 * (visitors.edit) is deliberately NOT reused here: that route is
 * Agent/Admin-facing (PermissionGuard-gated) and lets every field be
 * optional/partial; this one is visitor-facing, has no RBAC concept at
 * all, and Name/Email are mandatory per FR-WID-05's own wording.
 */
export class SubmitVisitorProfileDto {
  @ApiProperty({ example: 'Jane Doe' })
  @IsString()
  @MaxLength(200)
  name!: string;

  @ApiProperty({ example: 'jane.doe@example.com' })
  @IsEmail()
  email!: string;

  @ApiPropertyOptional({ example: '+1-555-0100' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  // FR-CFG-01/02 Forms builder (this session's addition) — answers to any
  // custom (non-builtin) field an admin added to the pre-chat form, keyed
  // by that field's `FormFieldConfig.id`. Builtin fields (name/email/phone)
  // still use their own typed properties above, not this map.
  @ApiPropertyOptional({
    example: { orderNumber: '#10234' },
    description: "Answers to any custom fields on the Site's pre-chat form.",
  })
  @IsOptional()
  @IsObject()
  customFields?: Record<string, string>;
}
