import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateDepartmentDto {
  @ApiProperty({ example: 'Sales (EMEA)' })
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;
}
