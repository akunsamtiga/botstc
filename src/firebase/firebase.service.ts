/**
 * firebase.service.ts
 *
 * ⚠️  FILE INI SUDAH DEPRECATED — TIDAK DIGUNAKAN LAGI.
 *
 * Aplikasi telah migrasi dari Firestore ke Supabase PostgreSQL.
 * Push notification (FCM) kini ditangani oleh PushNotificationService
 * di src/supabase/push-notification.service.ts menggunakan FCM_SERVICE_ACCOUNT_PATH.
 *
 * File ini dibiarkan sebagai stub agar tidak crash jika masih ada
 * referensi yang belum dihapus. Hapus FirebaseModule dari app.module.ts
 * untuk menghilangkan file ini dari dependency tree sepenuhnya.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    // Sebelumnya melempar Error jika config tidak ada → menyebabkan crash.
    // Sekarang hanya log warning — tidak melempar error sama sekali.
    // Aplikasi sudah menggunakan Supabase, bukan Firestore.
    this.logger.warn(
      '⚠️  FirebaseService: tidak digunakan (migrasi ke Supabase sudah selesai). ' +
      'Hapus FirebaseModule dari app.module.ts.',
    );
  }

  /** Stub — Firestore tidak lagi digunakan */
  get db(): never {
    throw new Error('FirebaseService.db tidak tersedia — aplikasi sudah migrasi ke Supabase.');
  }

  get FieldValue(): never {
    throw new Error('Gunakan supabaseService.now() sebagai pengganti FieldValue.serverTimestamp().');
  }

  get Timestamp(): never {
    throw new Error('Gunakan supabaseService.timestampFromMillis() sebagai pengganti Firestore Timestamp.');
  }

  async withBackoff<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}