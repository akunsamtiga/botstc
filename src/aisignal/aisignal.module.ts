import { Module } from '@nestjs/common';
import { AISignalController } from './aisignal.controller';
import { AISignalService } from './aisignal.service';
import { AISignalMonitorService } from './ai-signal-monitor.service';
import { FirebaseMessagingService } from '../firebase/firebase-messaging.service';
import { FirebaseModule } from '../firebase/firebase.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [FirebaseModule, AuthModule],
  controllers: [AISignalController],
  providers: [
    AISignalService,
    AISignalMonitorService,
    FirebaseMessagingService,
  ],
  exports: [AISignalService, AISignalMonitorService],
})
export class AISignalModule {}