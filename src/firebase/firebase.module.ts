import { Module, Global } from '@nestjs/common';
import { FirebaseService } from './firebase.service';
import { FirebaseMessagingService } from './firebase-messaging.service';

@Global()
@Module({
  providers: [FirebaseService, FirebaseMessagingService],
  exports: [FirebaseService, FirebaseMessagingService],
})
export class FirebaseModule {}