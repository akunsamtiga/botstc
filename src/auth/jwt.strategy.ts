import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { SupabaseService } from '../supabase/supabase.service';

/**
 * ✅ FIX v2: Tambah logging detail di validate() agar 401 bisa langsung di-debug.
 *
 * Sebelumnya, ketika session tidak ditemukan, error dilempar tanpa log sama sekali
 * sehingga tidak bisa dibedakan antara:
 *   (a) Session row tidak ada di Supabase (upsert gagal saat login)
 *   (b) logged_out_at terisi (user sudah logout sebelumnya)
 *   (c) Supabase query error (koneksi, RLS, dll)
 *
 * Sekarang setiap skenario di-log dengan context yang jelas.
 *
 * Cache behavior (tidak berubah):
 *   - TTL 30 detik — bypass Supabase untuk burst request dari satu user.
 *   - Cleanup otomatis setiap 5 menit agar tidak bocor memori.
 *   - Select hanya kolom 'user_id, logged_out_at' untuk efisiensi + debug.
 */

interface CacheEntry {
  userId: string;
  email: string;
  expiresAt: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);

  /** In-memory cache: userId → validated session entry */
  private readonly cache = new Map<string, CacheEntry>();

  /** TTL cache 30 detik — cukup untuk burst request dari satu user */
  private readonly CACHE_TTL_MS = 30_000;

  /** Cleanup cache setiap 5 menit supaya tidak bocor memori */
  private readonly cleanupInterval: NodeJS.Timer;

  constructor(
    private configService: ConfigService,
    private supabaseService: SupabaseService,
  ) {
    const secret = configService.get<string>('JWT_SECRET');

    // ✅ FIX: Validasi JWT_SECRET saat startup agar tidak diam-diam pakai
    //    secret kosong yang menyebabkan semua token dianggap invalid.
    if (!secret) {
      throw new Error(
        '❌ JWT_SECRET tidak terset di environment variables! ' +
        'Pastikan JWT_SECRET ada di file .env dan pm2 di-restart dengan --update-env.',
      );
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });

    // Cleanup expired entries setiap 5 menit
    this.cleanupInterval = setInterval(() => this.cleanupExpired(), 5 * 60_000);
  }

  private cleanupExpired() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now >= entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  /** Invalidate cache untuk userId tertentu (dipanggil saat logout) */
  invalidate(userId: string) {
    this.cache.delete(userId);
  }

  async validate(payload: { sub: string; email: string }) {
    const userId = payload.sub;

    // ── Cache hit: langsung return tanpa query Supabase ─────────────────────
    const cached = this.cache.get(userId);
    if (cached && Date.now() < cached.expiresAt) {
      return { userId: cached.userId, email: cached.email };
    }

    // ── Cache miss: query Supabase sekali, simpan ke cache ──────────────────
    // ✅ FIX: Select 'logged_out_at' juga supaya bisa di-log saat debug.
    const { data, error } = await this.supabaseService.client
      .from('sessions')
      .select('user_id, logged_out_at')
      .eq('user_id', userId)
      .maybeSingle();             // ← maybeSingle() tidak throw jika tidak ada row

    // ✅ FIX: Log setiap skenario kegagalan secara spesifik
    if (error) {
      this.logger.error(
        `❌ Supabase error saat validasi JWT untuk userId=${userId}: ` +
        `code=${error.code} | message=${error.message} | hint=${error.hint}`,
      );
      throw new UnauthorizedException('Database error, silakan coba lagi');
    }

    if (!data) {
      this.logger.warn(
        `❌ Session row TIDAK DITEMUKAN di Supabase untuk userId=${userId}. ` +
        `Kemungkinan: upsert saat login gagal. Cek log AuthService di atas.`,
      );
      throw new UnauthorizedException('Session tidak ditemukan, silakan login ulang');
    }

    if (data.logged_out_at !== null) {
      this.logger.warn(
        `❌ Session userId=${userId} sudah logout pada ${data.logged_out_at}. ` +
        `Token lama masih dipakai setelah logout.`,
      );
      throw new UnauthorizedException('Session sudah logout, silakan login ulang');
    }

    // ── Session valid: simpan ke cache ──────────────────────────────────────
    this.cache.set(userId, {
      userId,
      email: payload.email,
      expiresAt: Date.now() + this.CACHE_TTL_MS,
    });

    return { userId, email: payload.email };
  }
}