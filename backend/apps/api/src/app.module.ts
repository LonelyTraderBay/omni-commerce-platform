import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import {
  MEMBERSHIPS_REPOSITORY,
  OrgGuard,
  SupabaseMembershipsRepository,
} from './common/guards/org.guard';
import { AccountingModule } from './modules/accounting/accounting.module';
import { AdSpendModule } from './modules/ad-spend/ad-spend.module';
import { AdminOpsModule } from './modules/admin-ops/admin-ops.module';
import { AdvisorModule } from './modules/advisor/advisor.module';
import { AttributionModule } from './modules/attribution/attribution.module';
import { BillingModule } from './modules/billing/billing.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { ChannelsModule } from './modules/channels/channels.module';
import { CodModule } from './modules/cod/cod.module';
import { ContentCalendarModule } from './modules/content-calendar/content-calendar.module';
import { EinvoiceModule } from './modules/einvoice/einvoice.module';
import { FeatureFlagsModule } from './modules/feature-flags/feature-flags.module';
import { HealthModule } from './modules/health/health.module';
import { IdentityModule } from './modules/identity/identity.module';
import { InboxModule } from './modules/inbox/inbox.module';
import { InternalModule } from './modules/internal/internal.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PnlModule } from './modules/pnl/pnl.module';
import { PublicApiModule } from './modules/public-api/public-api.module';
import { ShippingModule } from './modules/shipping/shipping.module';
import { SupplierPoModule } from './modules/supplier-po/supplier-po.module';
import { WarehousesModule } from './modules/warehouses/warehouses.module';

@Module({
  imports: [
    HealthModule,
    BillingModule,
    IdentityModule,
    AdminOpsModule,
    CatalogModule,
    InventoryModule,
    ChannelsModule,
    InboxModule,
    OrdersModule,
    ShippingModule,
    CodModule,
    PnlModule,
    AdSpendModule,
    AttributionModule,
    AdvisorModule,
    ContentCalendarModule,
    PublicApiModule,
    WarehousesModule,
    SupplierPoModule,
    EinvoiceModule,
    AccountingModule,
    FeatureFlagsModule,
    InternalModule,
  ],
  providers: [
    {
      provide: MEMBERSHIPS_REPOSITORY,
      useClass: SupabaseMembershipsRepository,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: OrgGuard,
    },
  ],
})
export class AppModule {}
