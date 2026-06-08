import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Throttler yang mem-bucket per-USER (dari klaim `sub` token JWT) untuk request
 * ter-autentikasi, dan per-IP untuk request anonim (mis. /auth/login).
 *
 * Kenapa: ThrottlerGuard global berjalan SEBELUM JwtAuthGuard, jadi `req.user`
 * belum terisi. Kita decode `sub` langsung dari Bearer token (tanpa verifikasi —
 * cukup untuk keperluan keying rate-limit). Ini mencegah false-positive 429 saat
 * banyak user berbagi satu IP publik (carrier-grade NAT pada perangkat mobile),
 * yang akan terjadi bila throttling murni per-IP.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const auth: string | undefined = req.headers?.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      try {
        const part = auth.slice(7).split('.')[1];
        const payload = JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
        if (payload?.sub) return `u:${payload.sub}`;
      } catch {
        /* token tak bisa di-decode → fallback ke IP */
      }
    }
    const ip = (Array.isArray(req.ips) && req.ips.length ? req.ips[0] : req.ip) ?? 'unknown';
    return `ip:${ip}`;
  }
}
