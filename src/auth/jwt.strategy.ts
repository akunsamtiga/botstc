import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { SupabaseService } from '../supabase/supabase.service';

/**
 * ✅ FIX: Tambah in-memory session cache di JwtStrategy.
 *
 * ROOT CAUSE sebelumnya:
 *   validate() dipanggil untuk SETIAP request yang masuk.
 *   Ketika frontend fire 12+ request concurrent (loadAll / polling),
 *   12 query Supabase jalan bersamaan → sebagian timeout / kena rate-limit
 *   → error = true → throw UnauthorizedException → backend balik 401 massal.
 *
 * auth.service.ts sebenarnya sudah punya session cache, tapi JwtStrategy
 * tidak menggunakannya — ia langsung query Supabase sendiri.
 *
 * FIX:
 *   - Tambah cache lokal di JwtStrategy (TTL 30 detik).
 *   - Request ke user yang sama dalam 30 detik cukup pakai cache,
 *     tidak perlu query Supabase.
 *   - Select hanya kolom 'user_id' (bukan '*') untuk efisiensi.
 *   - Tambah cleanup otomatis agar cache tidak bocor memori.
 */

interface CacheEntry {
  userId: string;
  email: string;
  expiresAt: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
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
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'),
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
    const { data, error } = await this.supabaseService.client
      .from('sessions')
      .select('user_id')          // ← hanya kolom yang dibutuhkan, bukan '*'
      .eq('user_id', userId)
      .is('logged_out_at', null)  // ← pastikan belum logout
      .maybeSingle();             // ← maybeSingle() tidak throw jika tidak ada row

    if (error || !data) {
      throw new UnauthorizedException('Session tidak ditemukan, silakan login ulang');
    }

    // Simpan ke cache
    this.cache.set(userId, {
      userId,
      email: payload.email,
      expiresAt: Date.now() + this.CACHE_TTL_MS,
    });

    return { userId, email: payload.email };
  }
}