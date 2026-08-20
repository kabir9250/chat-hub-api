import { Module } from '@nestjs/common';

import { AttributionService } from './attribution.service';

/**
 * No DB/HTTP dependencies of its own — just wraps AttributionService (UA
 * parsing + GeoIP + UTM/visitor-path derivation, SRS §5.2) as an injectable
 * so any module (visitor-session today; a future pre-chat-form or
 * message-send endpoint tomorrow) can reuse the exact same logic.
 */
@Module({
  providers: [AttributionService],
  exports: [AttributionService],
})
export class AttributionModule {}
