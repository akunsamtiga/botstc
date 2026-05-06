import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import WebSocket = require('ws');

@Injectable()
export class SupabaseService implements OnModuleInit {
  private readonly logger = new Logger(SupabaseService.name);
  private _client: SupabaseClient;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const url = this.configService.get<string>('SUPABASE_URL');
    const serviceKey = this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY');

    if (!url || !serviceKey) {
      throw new Error(
        'Supabase config tidak lengkap. Set SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY di .env',
      );
    }

    this._client = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { transport: WebSocket as any },
    });

    this.logger.log('✅ Supabase PostgreSQL terhubung');
  }

  get client(): SupabaseClient {
    return this._client;
  }

  /**
   * Returns the current UTC timestamp as an ISO string.
   * Replaces Firestore FieldValue.serverTimestamp().
   */
  now(): string {
    return new Date().toISOString();
  }

  /**
   * Convert a millisecond timestamp to an ISO string.
   * Replaces Firestore Timestamp.fromMillis().
   */
  timestampFromMillis(millis: number): string {
    return new Date(millis).toISOString();
  }

  /**
   * Utility: jalankan Supabase operation dengan exponential backoff.
   * Berguna ketika rate-limit atau network error terjadi —
   * akan retry dengan delay yang meningkat hingga maxAttempts.
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
        const isRetryable =
          code === '429' ||
          code === 'PGRST116' ||
          code === 'PGRST301' ||
          (typeof code === 'string' && code.includes('rate limit')) ||
          (typeof error?.message === 'string' && error.message.includes('timeout'));

        if (!isRetryable || attempt === maxAttempts) {
          throw error;
        }

        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        this.logger.warn(
          `Supabase retryable error (attempt ${attempt}/${maxAttempts}), ` +
            `retrying in ${delay}ms...`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError;
  }
}