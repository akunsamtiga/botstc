import { Module } from '@nestjs/common';
import { AISignalController } from './aisignal.controller';
import { AISignalService } from './aisignal.service';
import { AISignalMonitorService } from './ai-signal-monitor.service';
import { TelegramSignalService } from './telegram-signal.service';
import { FirebaseMessagingService } from '../firebase/firebase-messaging.service';
import { FirebaseModule } from '../firebase/firebase.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [FirebaseModule, AuthModule],
  controllers: [AISignalController],
  providers: [
    AISignalService,
    AISignalMonitorService,
    TelegramSignalService,
    FirebaseMessagingService,
  ],
  exports: [AISignalService, AISignalMonitorService, TelegramSignalService],
})
export class AISignalModule {}