import { Module } from '@nestjs/common';
import { AISignalController } from './aisignal.controller';
import { AISignalService } from './aisignal.service';
import { AISignalMonitorService } from './ai-signal-monitor.service';
import { TelegramSignalService } from './telegram-signal.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [SupabaseModule, AuthModule],
  controllers: [AISignalController],
  providers: [
    AISignalService,
    AISignalMonitorService,
    TelegramSignalService,
  ],
  exports: [AISignalService, AISignalMonitorService, TelegramSignalService],
})
export class AISignalModule {}