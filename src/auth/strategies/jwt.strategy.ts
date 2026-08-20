import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectModel } from '@nestjs/mongoose';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Model } from 'mongoose';

import { User, UserDocument } from '../../database/schemas';
import { AppJwtPayload } from '../interfaces/jwt-payload.interface';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

/**
 * Verifies the JWT signature/expiry (passport-jwt handles that part
 * automatically) then re-loads the User from the DB on every request —
 * deliberately not trusting stale claims baked into the token, so a
 * disabled/deleted user is rejected immediately rather than waiting for
 * the token to expire (SRS FR-USR-06).
 *
 * Only `type: 'user'` payloads are accepted here — a Visitor session
 * token (see VisitorSessionService) will fail this strategy, which is
 * what keeps the two token kinds from being interchangeable.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // JWT_SECRET is required by env.validation.ts (Joi) — the app fails
      // fast at startup if unset, so this is never actually undefined here.
      secretOrKey: configService.get<string>('app.jwt.secret') as string,
    });
  }

  async validate(payload: AppJwtPayload): Promise<AuthenticatedUser> {
    if (payload.type !== 'user') {
      throw new UnauthorizedException(
        'This token is not a valid user session.',
      );
    }

    const user = await this.userModel.findById(payload.sub).exec();
    if (!user) {
      throw new UnauthorizedException('User no longer exists.');
    }
    if (!user.enabled) {
      throw new UnauthorizedException('This account has been disabled.');
    }

    return {
      userId: user._id.toString(),
      organizationId: user.organizationId.toString(),
      email: user.email,
      displayName: user.displayName,
      fullName: user.fullName,
      enabled: user.enabled,
      status: user.status,
    };
  }
}
