import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  Shortcut,
  ShortcutSchema,
  Site,
  SiteSchema,
} from '../database/schemas';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { RbacModule } from '../rbac/rbac.module';
import { ShortcutsController } from './shortcuts.controller';
import { ShortcutsService } from './shortcuts.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Shortcut.name, schema: ShortcutSchema },
      { name: Site.name, schema: SiteSchema },
    ]),
    AuditLogModule,
    RbacModule,
  ],
  controllers: [ShortcutsController],
  providers: [ShortcutsService],
})
export class ShortcutsModule {}
