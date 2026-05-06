import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SupabaseService } from './supabase.service';
import { PushNotificationService } from './push-notification.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [SupabaseService, PushNotificationService],
  exports: [SupabaseService, PushNotificationService],
})
export class SupabaseModule {}
