import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private _db: admin.firestore.Firestore;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    if (admin.apps.length === 0) {
      const serviceAccountPath = this.configService.get<string>('FIREBASE_SERVICE_ACCOUNT_PATH');
      const projectId = this.configService.get<string>('FIREBASE_PROJECT_ID');

      if (serviceAccountPath) {
        // Resolve path relatif dari project root
        const path = require('path');
        const resolvedPath = path.resolve(process.cwd(), serviceAccountPath);
        const serviceAccount = require(resolvedPath);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          projectId: serviceAccount.project_id || projectId,
        });
      } else {
        const privateKey = this.configService.get<string>('FIREBASE_PRIVATE_KEY');
        const clientEmail = this.configService.get<string>('FIREBASE_CLIENT_EMAIL');
        if (!privateKey || !clientEmail || !projectId) {
          throw new Error(
            'Firebase config tidak lengkap. Set FIREBASE_SERVICE_ACCOUNT_PATH atau ' +
            'FIREBASE_PRIVATE_KEY + FIREBASE_CLIENT_EMAIL + FIREBASE_PROJECT_ID di .env'
          );
        }
        admin.initializeApp({
          credential: admin.credential.cert({
            projectId,
            privateKey: privateKey.replace(/\\n/g, '\n'),
            clientEmail,
          }),
        });
      }
    }
    this._db = admin.firestore();
    this.logger.log('✅ Firebase Firestore terhubung');
  }

  get db(): admin.firestore.Firestore {
    return this._db;
  }

  get FieldValue() {
    return admin.firestore.FieldValue;
  }

  get Timestamp() {
    return admin.firestore.Timestamp;
  }

  /**
   * Utility: jalankan Firestore operation dengan exponential backoff.
   * Berguna ketika RESOURCE_EXHAUSTED (quota exceeded) terjadi —
   * akan retry dengan delay yang meningkat hingga maxAttempts.
   *
   * @param operation - async function yang mengembalikan Promise<T>
   * @param maxAttempts - maksimum retry (default 3)
   * @param baseDelayMs - delay awal dalam ms (default 500)
   */
  async withBackoff<T>(
    operation: () => Promise<T>,
    maxAttempts = 3,
    baseDelayMs = 500,
  ): Promise<T> {
    let lastError: any;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;
        const code = error?.code || error?.message || '';
        const isResourceExhausted =
          code === 8 ||
          code === 'RESOURCE_EXHAUSTED' ||
          (typeof code === 'string' && code.includes('RESOURCE_EXHAUSTED')) ||
          (typeof error?.message === 'string' && error.message.includes('Quota exceeded'));

        if (!isResourceExhausted || attempt === maxAttempts) {
          throw error;
        }

        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        this.logger.warn(
          `Firestore RESOURCE_EXHAUSTED (attempt ${attempt}/${maxAttempts}), ` +
          `retrying in ${delay}ms...`
        );
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastError;
  }
}