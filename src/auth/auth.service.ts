import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { Model } from 'mongoose';
import * as bcrypt from 'bcryptjs';

import { User, UserDocument } from '../database/schemas';
import { AuditLogService } from '../audit-log/audit-log.service';
import { UserJwtPayload } from './interfaces/jwt-payload.interface';

export interface LoginResult {
  accessToken: string;
  expiresIn: string;
  user: {
    userId: string;
    organizationId: string;
    email: string;
    displayName: string;
    fullName: string;
  };
}

/**
 * FR-AUTH-01: email + password, bcrypt-hashed, JWT-based session.
 *
 * Single access token, no refresh token — see PROGRESS.md ("Session 2 —
 * Auth" key decisions) for why: the JWT expiry (`JWT_EXPIRES_IN`, default
 * 1d) is short enough for Phase 1's internal Agent/Admin user base that a
 * refresh flow isn't worth the added surface area yet; re-login on expiry
 * is an acceptable UX for Phase 1. Revisit if session length becomes a
 * problem.
 */
@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly jwtService: JwtService,
    private readonly auditLogService: AuditLogService,
    private readonly configService: ConfigService,
  ) {}

  async login(email: string, password: string): Promise<LoginResult> {
    // passwordHash has `select: false` in the schema — explicitly ask
    // for it here, since login is the one place that legitimately needs it.
    const user = await this.userModel
      .findOne({ email: email.trim().toLowerCase() })
      .select('+passwordHash')
      .exec();

    if (!user) {
      throw new UnauthorizedException('Invalid email or password.');
    }
    if (!user.enabled) {
      throw new UnauthorizedException('This account has been disabled.');
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      await this.auditLogService.record({
        actorType: 'user',
        actorId: user._id,
        action: 'auth.login_failed',
        metadata: { email: user.email },
      });
      throw new UnauthorizedException('Invalid email or password.');
    }

    const payload: UserJwtPayload = {
      sub: user._id.toString(),
      email: user.email,
      type: 'user',
    };
    const accessToken = this.jwtService.sign(payload);

    await this.auditLogService.record({
      actorType: 'user',
      actorId: user._id,
      action: 'auth.login',
    });

    return {
      accessToken,
      expiresIn: this.configService.get<string>('app.jwt.expiresIn') ?? '1d',
      user: {
        userId: user._id.toString(),
        organizationId: user.organizationId.toString(),
        email: user.email,
        displayName: user.displayName,
        fullName: user.fullName,
      },
    };
  }
}
