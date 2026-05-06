import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SupabaseService } from '../supabase/supabase.service';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';

const execFileAsync = promisify(execFile);

const BASE_URL = 'https://api.stockity.id';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const DEFAULT_TIMEZONE = 'Asia/Bangkok';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /**
   * In-memory session cache untuk mengurangi read Supabase.
   * TTL: 30 detik — cukup untuk burst request dari frontend polling,
   * tapi tidak terlalu lama agar session updates tetap terbaca.
   */
  private sessionCache = new Map<string, { data: any; expiresAt: number }>();
  private readonly SESSION_CACHE_TTL_MS = 30_000;

  constructor(
    private jwtService: JwtService,
    private supabaseService: SupabaseService,
  ) {}

  // ── Cache helpers ─────────────────────────────────────────────────────────

  private getCachedSession(userId: string): any | null {
    const cached = this.sessionCache.get(userId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }
    return null;
  }

  private setCachedSession(userId: string, data: any) {
    this.sessionCache.set(userId, {
      data,
      expiresAt: Date.now() + this.SESSION_CACHE_TTL_MS,
    });
  }

  private invalidateSessionCache(userId: string) {
    this.sessionCache.delete(userId);
  }

  // ── curlPost ──────────────────────────────────────────────────────────────
  // Gunakan curl binary (bukan axios) untuk bypass Cloudflare JA3/JA4 fingerprint
  // blocking. Node.js/axios memiliki TLS fingerprint berbeda dari browser/curl,
  // sehingga Cloudflare silently hang koneksinya (ETIMEDOUT, no response).
  // curl dari VPS ini terbukti lolos (HTTP 422 pada test dengan kredensial salah).
  private async curlPost(
    url: string,
    body: object,
    headers: Record<string, string>,
  ): Promise<{ status: number; data: any }> {
    const headerArgs: string[] = [];
    for (const [k, v] of Object.entries(headers)) {
      headerArgs.push('-H', `${k}: ${v}`);
    }

    const { stdout } = await execFileAsync('curl', [
      '-s',
      '-X', 'POST',
      url,
      ...headerArgs,
      '-H', 'Content-Type: application/json',
      '-d', JSON.stringify(body),
      '--max-time', '15',
      '-w', '\n__HTTP_STATUS__%{http_code}',
    ]);

    const parts      = stdout.split('\n__HTTP_STATUS__');
    const statusCode = parseInt(parts[1]?.trim() ?? '0', 10);
    const rawBody    = parts[0].trim();

    if (!rawBody || statusCode === 0) {
      const err: any = new Error('');
      err.code = 'ETIMEDOUT';
      throw err;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new Error(`Non-JSON response (HTTP ${statusCode}): ${rawBody.slice(0, 300)}`);
    }

    return { status: statusCode, data: parsed };
  }

  async login(email: string, password: string) {
    this.logger.log(`Login attempt: ${email}`);

    // Ambil deviceId lama jika sudah pernah login
    let deviceId = uuidv4();
    try {
      const { data: existing } = await this.supabaseService.client
        .from('sessions')
        .select('*')
        .eq('email', email)
        .limit(1)
        .maybeSingle();
      if (existing) {
        if (existing.device_id) deviceId = existing.device_id;
      }
    } catch (_) {}

    let stockityAuthToken: string;
    let stockityUserId: string;

    try {
      const result = await this.curlPost(
        `${BASE_URL}/passport/v2/sign_in?locale=id`,
        { email, password },
        {
          'device-id':     deviceId,
          'device-type':   'web',
          'user-timezone': DEFAULT_TIMEZONE,
          'accept':        'application/json, text/plain, */*',
          'User-Agent':    DEFAULT_USER_AGENT,
          'Origin':        'https://stockity.id',
          'Referer':       'https://stockity.id/',
        },
      );

      if (result.status >= 400) {
        const body = result.data;
        this.logger.error(
          `Stockity login error [HTTP ${result.status}]: ` +
          `${JSON.stringify(body).slice(0, 500)}`,
        );
        const errMsg: string =
          body?.errors?.[0]?.message ||
          body?.errors?.[0]           ||
          body?.message               ||
          body?.error                 ||
          (result.status === 401 || result.status === 403 || result.status === 422
            ? 'Email atau password salah'
            : result.status === 423
            ? 'Akun diblokir'
            : result.status >= 500
            ? 'Server Stockity bermasalah, coba lagi nanti'
            : 'Login gagal');
        throw new UnauthorizedException(errMsg);
      }

      // Response shape: { data: { authtoken: string, user_id: string } }
      const d = result.data?.data ?? {};

      stockityAuthToken = d.authtoken ?? '';
      stockityUserId    = String(d.user_id ?? d.userId ?? '');

      if (!stockityAuthToken) {
        this.logger.error(
          `Token kosong. Response keys: [${Object.keys(d).join(', ')}] | ` +
          `Body: ${JSON.stringify(d).slice(0, 300)}`,
        );
        throw new UnauthorizedException('Email atau password salah');
      }

      if (!stockityUserId) {
        this.logger.error(`user_id tidak ditemukan. Data: ${JSON.stringify(d).slice(0, 300)}`);
        throw new UnauthorizedException('Login gagal: user_id tidak ditemukan');
      }

    } catch (err: any) {
      if (err instanceof UnauthorizedException) throw err;

      const errCode  = err?.code ?? 'unknown';
      const rawMsg   = err?.message || '(empty message)';
      this.logger.error(
        `Stockity login error\n` +
        `  code    : ${errCode}\n` +
        `  message : ${rawMsg}`,
      );

      const errMsg =
        errCode === 'ETIMEDOUT'     ? 'Koneksi ke Stockity timeout, coba lagi' :
        errCode === 'ECONNREFUSED'  ? 'Tidak bisa terhubung ke Stockity'       :
        rawMsg || 'Login gagal';

      throw new UnauthorizedException(errMsg);
    }

    // Simpan session ke Supabase
    await this.supabaseService.client
      .from('sessions')
      .upsert({
        user_id:         stockityUserId,
        email,
        stockity_token:  stockityAuthToken,
        device_id:       deviceId,
        device_type:     'web',
        user_agent:      DEFAULT_USER_AGENT,
        user_timezone:   DEFAULT_TIMEZONE,
        currency:        'IDR',
        currency_iso:    'IDR',
        updated_at:      this.supabaseService.now(),
      });

    // Invalidate cache setelah write
    this.invalidateSessionCache(stockityUserId);

    const jwt = this.jwtService.sign({ sub: stockityUserId, email });
    this.logger.log(`✅ Login berhasil: ${email} (userId: ${stockityUserId})`);

    return {
      accessToken: jwt,
      userId:      stockityUserId,
      email,
      deviceId,
    };
  }

  async logout(userId: string) {
    await this.supabaseService.client
      .from('sessions')
      .upsert({
        user_id: userId,
        logged_out_at: this.supabaseService.now(),
      });
    this.invalidateSessionCache(userId);
    return { message: 'Logout berhasil' };
  }

  async getMe(userId: string) {
    const cached = this.getCachedSession(userId);
    if (cached) {
      return {
        userId:      cached.user_id,
        email:       cached.email,
        deviceId:    cached.device_id,
        currency:    cached.currency,
        currencyIso: cached.currency_iso,
      };
    }

    const { data, error } = await this.supabaseService.client
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error || !data) throw new UnauthorizedException('Session tidak ditemukan');
    this.setCachedSession(userId, data);
    return {
      userId:      data.user_id,
      email:       data.email,
      deviceId:    data.device_id,
      currency:    data.currency,
      currencyIso: data.currency_iso,
    };
  }

  async getSession(userId: string) {
    const cached = this.getCachedSession(userId);
    if (cached) {
      return cached;
    }

    const { data, error } = await this.supabaseService.client
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error || !data) return null;
    this.setCachedSession(userId, data);
    return data;
  }
}