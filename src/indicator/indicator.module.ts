import { Module } from '@nestjs/common';
import { IndicatorService } from './indicator.service';
import { IndicatorController } from './indicator.controller';
import { SupabaseModule } from '../supabase/supabase.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [SupabaseModule, AuthModule],
  providers: [IndicatorService],
  controllers: [IndicatorController],
  exports: [IndicatorService],
})
export class IndicatorModule {}