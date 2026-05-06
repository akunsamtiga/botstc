/**
 * firebase.module.ts
 *
 * ⚠️  DEPRECATED — Hapus import FirebaseModule dari app.module.ts.
 *
 * Module ini sekarang hanya menyediakan FirebaseService stub (tidak crash).
 * FirebaseMessagingService dihapus — gunakan PushNotificationService dari
 * SupabaseModule sebagai gantinya (sudah @Global dan tersedia di seluruh app).
 *
 * Cara hapus sepenuhnya:
 *   1. Pastikan tidak ada `import { FirebaseModule }` di app.module.ts (sudah dihapus).
 *   2. Hapus folder src/firebase/ jika tidak ada modul lain yang menggunakannya.
 */
import { Module, Global } from '@nestjs/common';
import { FirebaseService } from './firebase.service';

@Global()
@Module({
  providers: [FirebaseService],
  exports: [FirebaseService],
})
export class FirebaseModule {}