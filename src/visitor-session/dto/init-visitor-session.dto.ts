import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsMongoId, IsOptional, IsString, IsUrl } from 'class-validator';

export class InitVisitorSessionDto {
  @ApiProperty({
    example: '507f1f77bcf86cd799439011',
    description:
      'A real Site _id (see GET /sites/:siteId/business-hours or ask an Owner for one).',
  })
  @IsMongoId()
  siteId!: string;

  // Legacy resume path (Session 2): if given and no valid `Authorization:
  // Bearer <visitor token>` header is present, resolves this id to an
  // existing Visitor on this Site. Kept for backward compatibility only —
  // prefer the Authorization header (see VisitorSessionService doc comment):
  // a bare visitorId is guessable/spoofable by anyone, since it proves
  // nothing about who's asking. The widget should send the token it was
  // previously issued instead, once it has one.
  @ApiPropertyOptional({
    example: '507f1f77bcf86cd799439033',
    description:
      'Deprecated fallback: a previously-issued Visitor _id. Prefer sending the ' +
      "prior session's token as `Authorization: Bearer <token>` instead — that " +
      'proves ownership of the session; this field does not.',
  })
  @IsOptional()
  @IsMongoId()
  visitorId?: string;

  // FR-VIS-01: the widget's current page URL — source of both `landingPage`
  // and any `utm_*` query params. Not required (a non-browser caller, e.g.
  // this session's own curl verification, may omit it), but the widget
  // frontend should always send `window.location.href` here.
  @ApiPropertyOptional({
    example:
      'https://brand-site-1.example.com/pricing?utm_source=google&utm_medium=cpc',
    description:
      "The widget's current page URL (window.location.href). Source of " +
      '`landingPage` and any utm_* query params (FR-VIS-01).',
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  pageUrl?: string;

  // FR-VIS-01: `document.referrer` from the widget, if any. Empty/absent
  // means "Direct traffic" per FR-VIS-02.
  @ApiPropertyOptional({
    example: 'https://www.google.com/search?q=chat+widget',
    description:
      'document.referrer from the widget, if any (FR-VIS-01/02). Omit or send ' +
      'empty string for direct traffic.',
  })
  @IsOptional()
  @IsString()
  referrer?: string;
}
