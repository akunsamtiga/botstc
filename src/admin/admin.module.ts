import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard, SuperAdminGuard } from './admin.guard';
import { MailService } from '../mail/mail.service';

@Module({
  imports: [SupabaseModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard, SuperAdminGuard, MailService],
})
export class AdminModule {}
