import { Module } from '@nestjs/common';

import { VisitorPresenceService } from './visitor-presence.service';

/** Leaf module — same shape as PresenceModule. See VisitorPresenceService's doc comment. */
@Module({
  providers: [VisitorPresenceService],
  exports: [VisitorPresenceService],
})
export class VisitorPresenceModule {}
