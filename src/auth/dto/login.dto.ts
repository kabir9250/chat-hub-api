import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    example: 'owner@chat-hub.local',
    description:
      'One of the seeded accounts: owner@chat-hub.local, manager@chat-hub.local, ' +
      'supervisor.site1@chat-hub.local, agent.site1@chat-hub.local — all use the same password.',
  })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'ChangeMe123!' })
  @IsString()
  @MinLength(1)
  password!: string;
}
