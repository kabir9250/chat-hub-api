import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateRoleDto {
  @ApiProperty({ example: 'Team Lead' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    example: 'Manages one Department, no billing access.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  // Validated against the actual PERMISSION_CATALOG (not just "is a
  // string") in RolesService — class-validator alone can't check catalog
  // membership without hardcoding the enum here, which would drift.
  @ApiProperty({
    description:
      'Keys from GET /permissions. You can only grant keys you already hold yourself.',
    example: [
      'conversations.view_site',
      'conversations.assign',
      'conversations.close',
    ],
    isArray: true,
    type: String,
  })
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissions!: string[];
}
