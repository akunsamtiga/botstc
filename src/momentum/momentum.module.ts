import { Module } from '@nestjs/common';
import { MomentumService } from './momentum.service';
import { MomentumController } from './momentum.controller';
import { FirebaseModule } from '../firebase/firebase.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [FirebaseModule, AuthModule],
  providers: [MomentumService],
  controllers: [MomentumController],
  exports: [MomentumService],
})
export class MomentumModule {}
