// src/today-profit/today-profit.module.ts
import { Module } from '@nestjs/common';
import { TodayProfitService } from './today-profit.service';
import { TodayProfitController } from './today-profit.controller';
import { StockityHistoryService } from './stockity-history.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [SupabaseModule, AuthModule],
  providers: [TodayProfitService, StockityHistoryService],
  controllers: [TodayProfitController],
  exports: [TodayProfitService],
})
export class TodayProfitModule {}