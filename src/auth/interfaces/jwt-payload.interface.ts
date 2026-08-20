/**
 * JWT payload shapes issued by this service.
 *
 * Two distinct token "kinds" share the same JWT_SECRET/verification
 * pipeline but are never interchangeable: a `type` discriminator is
 * embedded and checked on every verify so a Visitor token can never be
 * used to authenticate as a User (see JwtStrategy.validate()).
 */
export interface UserJwtPayload {
  sub: string; // User._id
  email: string;
  type: 'user';
}

export interface VisitorJwtPayload {
  sub: string; // Visitor._id
  siteId: string;
  type: 'visitor';
}

export type AppJwtPayload = UserJwtPayload | VisitorJwtPayload;
