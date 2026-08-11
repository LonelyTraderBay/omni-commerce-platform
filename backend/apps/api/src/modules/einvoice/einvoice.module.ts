import { Module } from '@nestjs/common';

import { PermissionsGuard } from '../authz/permissions.guard';
import { EinvoiceController } from './einvoice.controller';
import { EinvoiceService } from './einvoice.service';

@Module({
  controllers: [EinvoiceController],
  providers: [EinvoiceService, PermissionsGuard],
})
export class EinvoiceModule {}
