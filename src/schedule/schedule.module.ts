import { Module } from '@nestjs/common';
import { ScheduleController } from './schedule.controller';
import { ScheduleService } from './schedule.service';
import { OrderTrackingService } from './order-tracking.service';
import { FirebaseModule } from '../firebase/firebase.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [FirebaseModule, AuthModule],
  controllers: [ScheduleController],
  providers: [ScheduleService, OrderTrackingService],
  exports: [ScheduleService, OrderTrackingService],
})
export class ScheduleModule {}