import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { UserThrottlerGuard } from './common/user-throttler.guard';
import { SupabaseModule } from './supabase/supabase.module';
import { AuthModule } from './auth/auth.module';
import { ProfileModule } from './profile/profile.module';
import { ScheduleModule as ScheduleAppModule } from './schedule/schedule.module';
import { FastradeModule } from './fastrade/fastrade.module';
import { IndicatorModule } from './indicator/indicator.module';
import { MomentumModule } from './momentum/momentum.module';
import { AISignalModule } from './aisignal/aisignal.module';
import { TodayProfitModule } from './today-profit/today-profit.module';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    // ── Rate limiting global (H1) ─────────────────────────────────────────
    // Default 300 req / 60 dtk per-USER (token) atau per-IP (anonim).
    // Longgar agar polling dashboard tak kena 429; endpoint sensitif (login,
    // register-whitelist) diberi batas ketat lewat @Throttle() pada handler-nya.
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 300 },
    ]),
    SupabaseModule,
    AuthModule,
    ProfileModule,
    ScheduleAppModule,
    FastradeModule,
    IndicatorModule,
    MomentumModule,
    AISignalModule,
    TodayProfitModule,
    AdminModule,
  ],
  providers: [
    // Guard throttle global — per-user (token) / per-IP (anonim).
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
  ],
})
export class AppModule {}
