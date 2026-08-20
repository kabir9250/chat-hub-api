import { Module } from '@nestjs/common';

import { RealtimeEventsService } from './realtime-events.service';

/** Leaf module, no imports — see RealtimeEventsService's doc comment for why. */
@Module({
  providers: [RealtimeEventsService],
  exports: [RealtimeEventsService],
})
export class RealtimeEventsModule {}
