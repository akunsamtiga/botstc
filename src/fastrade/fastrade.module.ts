import { Module } from '@nestjs/common';
import { FastradeController } from './fastrade.controller';
import { FastradeService } from './fastrade.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [SupabaseModule, AuthModule],
  controllers: [FastradeController],
  providers: [FastradeService],
})
export class FastradeModule {}