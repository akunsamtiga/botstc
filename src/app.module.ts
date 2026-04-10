// src/app.module.ts (update)
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { FirebaseModule } from './firebase/firebase.module';
import { AuthModule } from './auth/auth.module';
import { ProfileModule } from './profile/profile.module';
import { ScheduleAppModule } from './schedule/schedule.module';
import { FastradeModule } from './fastrade/fastrade.module';
import { IndicatorModule } from './indicator/indicator.module';
import { MomentumModule } from './momentum/momentum.module';
import { AISignalModule } from './aisignal/aisignal.module';
import { TodayProfitModule } from './today-profit/today-profit.module'; 

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    FirebaseModule,
    AuthModule,
    ProfileModule,
    ScheduleAppModule,
    FastradeModule,
    IndicatorModule,
    MomentumModule,
    AISignalModule,
    TodayProfitModule, 
  ],
})
export class AppModule {}