import { Module } from '@nestjs/common';
import { MomentumService } from './momentum.service';
import { MomentumController } from './momentum.controller';
import { AuthModule } from '../auth/auth.module';

// SupabaseModule is @Global() — no need to import it here.
// FirebaseModule removed: MomentumService now uses SupabaseService.

@Module({
  imports: [AuthModule],
  providers: [MomentumService],
  controllers: [MomentumController],
  exports: [MomentumService],
})
export class MomentumModule {}