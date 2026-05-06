import { Module } from '@nestjs/common';
import { ScheduleController } from './schedule.controller';
import { ScheduleService } from './schedule.service';
import { OrderTrackingService } from './order-tracking.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [SupabaseModule, AuthModule],
  controllers: [ScheduleController],
  providers: [ScheduleService, OrderTrackingService],
  exports: [ScheduleService, OrderTrackingService],
})
export class ScheduleModule {}