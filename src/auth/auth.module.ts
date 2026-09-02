import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { MongooseModule } from '@nestjs/mongoose';

import { User, UserSchema } from '../database/schemas';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { RbacModule } from '../rbac/rbac.module';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LoginAttemptService } from './login-attempt.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('app.jwt.secret'),
        // JWT_EXPIRES_IN (env.validation.ts, Joi-validated, defaults '1d')
        // is a plain `string` — `as any` bridges to @nestjs/jwt's stricter
        // `number | StringValue` signOptions type.
        signOptions: {
          expiresIn: configService.get<string>('app.jwt.expiresIn') as any,
        },
      }),
    }),
    AuditLogModule,
    RbacModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, LoginAttemptService],
  exports: [JwtModule, PassportModule],
})
export class AuthModule {}
