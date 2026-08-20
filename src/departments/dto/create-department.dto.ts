import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateDepartmentDto {
  @ApiProperty({ example: 'Sales' })
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;
}
