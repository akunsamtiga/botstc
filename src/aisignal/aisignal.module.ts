import { Module } from '@nestjs/common';
import { AISignalService } from './aisignal.service';
import { AISignalController } from './aisignal.controller';
import { FirebaseModule } from '../firebase/firebase.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [FirebaseModule, AuthModule],
  providers: [AISignalService],
  controllers: [AISignalController],
  exports: [AISignalService],
})
export class AISignalModule {}
