import { Injectable, Logger, UnauthorizedException, HttpException, HttpStatus } from '@nestjs/common';
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

/**
 * Proxy untuk request login ke Stockity.
 * Isi di .env:
 *   Cara A (SSH SOCKS5) : LOGIN_PROXY=socks5://127.0.0.1:1080
 *   Cara B (Tinyproxy)  : LOGIN_PROXY=http://IP_VPS_BERSIH:8888
 * Kosongkan / hapus untuk tidak pakai proxy.
 */
const LOGIN_PROXY = process.env.LOGIN_PROXY ?? '';

/**
 * Durasi cooldown antar percobaan login per email (ms).
 * Mencegah spam login yang memicu rate limit Stockity (HTTP 429).
 * Default: 15 detik — cukup longgar untuk UX normal tapi mencegah loop.
 */
const LOGIN_COOLDOWN_MS = 15_000;

/**
 * Durasi blokir saat terkena HTTP 429 dari Stockity (ms).
 * Saat terkena 429, semua request login dari email yang sama diblokir
 * selama durasi ini agar IP VPS tidak semakin dibanned.
 * Default: 5 menit.
 */
const RATE_LIMIT_BLOCK_MS = 5 * 60_000;

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

  /**
   * Cooldown tracker per email — mencegah spam login ke Stockity.
   * Key: email, Value: timestamp terakhir login attempt (ms).
   */
  private loginCooldown = new Map<string, number>();

  /**
   * Rate limit block tracker — saat Stockity kembalikan 429,
   * blokir semua login dari email tersebut selama RATE_LIMIT_BLOCK_MS.
   * Key: email, Value: timestamp kapan blokir berakhir (ms).
   */
  private rateLimitBlockUntil = new Map<string, number>();

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

  invalidateSessionCache(userId: string) {
    this.sessionCache.delete(userId);
  }

  // ── Rate limit helpers ────────────────────────────────────────────────────

  /**
   * Cek apakah email sedang dalam cooldown atau blokir 429.
   * Melempar HttpException jika masih diblokir, dengan pesan yang informatif.
   */
  private checkLoginRateLimit(email: string): void {
    const now = Date.now();

    // Cek blokir 429 (prioritas pertama — lebih panjang durasinya)
    const blockedUntil = this.rateLimitBlockUntil.get(email);
    if (blockedUntil && now < blockedUntil) {
      const remainingSec = Math.ceil((blockedUntil - now) / 1000);
      const remainingMin = Math.ceil(remainingSec / 60);
      this.logger.warn(
        `🚫 Login ${email} diblokir sementara (429 cooldown). ` +
        `Sisa: ${remainingSec}s`,
      );
      throw new HttpException(
        `Terlalu banyak percobaan login. Silakan coba lagi dalam ${remainingMin} menit.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Cek cooldown normal antar attempt
    const lastAttempt = this.loginCooldown.get(email);
    if (lastAttempt && now - lastAttempt < LOGIN_COOLDOWN_MS) {
      const waitSec = Math.ceil((LOGIN_COOLDOWN_MS - (now - lastAttempt)) / 1000);
      this.logger.warn(
        `⏳ Login ${email} terlalu cepat. Tunggu ${waitSec}s lagi.`,
      );
      throw new HttpException(
        `Terlalu cepat, tunggu ${waitSec} detik sebelum coba login lagi.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Set timestamp attempt login terbaru untuk email ini.
   * Dipanggil tepat sebelum mengirim request ke Stockity.
   */
  private recordLoginAttempt(email: string): void {
    this.loginCooldown.set(email, Date.now());
  }

  /**
   * Aktifkan blokir panjang untuk email saat Stockity kembalikan 429.
   * Ini melindungi IP VPS dari semakin diblokir Stockity.
   */
  private applyRateLimitBlock(email: string): void {
    const blockUntil = Date.now() + RATE_LIMIT_BLOCK_MS;
    this.rateLimitBlockUntil.set(email, blockUntil);
    const blockMin = Math.ceil(RATE_LIMIT_BLOCK_MS / 60_000);
    this.logger.warn(
      `⛔ Rate limit block diaktifkan untuk ${email} selama ${blockMin} menit ` +
      `(sampai ${new Date(blockUntil).toISOString()}) karena HTTP 429 dari Stockity.`,
    );
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
    proxy?: string,
  ): Promise<{ status: number; data: any }> {
    const headerArgs: string[] = [];
    for (const [k, v] of Object.entries(headers)) {
      headerArgs.push('-H', `${k}: ${v}`);
    }

    // Tambahkan --proxy hanya jika proxy diisi
    const proxyArgs: string[] = proxy ? ['--proxy', proxy] : [];
    if (proxy) this.logger.debug(`curlPost via proxy: ${proxy} → ${url}`);

    const { stdout } = await execFileAsync('curl', [
      '-s',
      '-X', 'POST',
      url,
      ...headerArgs,
      '-H', 'Content-Type: application/json',
      '-d', JSON.stringify(body),
      '--max-time', '15',
      ...proxyArgs,
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

    // ── FIX: Cek rate limit & cooldown sebelum menyentuh Stockity ────────────
    this.checkLoginRateLimit(email);

    // Ambil deviceId lama jika sudah pernah login
    let deviceId = uuidv4();
    try {
      const { data: existing } = await this.supabaseService.client
        .from('sessions')
        .select('device_id')
        .eq('email', email)
        .limit(1)
        .maybeSingle();
      if (existing?.device_id) {
        deviceId = existing.device_id;
        this.logger.log(`Reusing existing deviceId for ${email}`);
      }
    } catch (e) {
      this.logger.warn(`Gagal ambil deviceId lama, pakai baru: ${e}`);
    }

    let stockityAuthToken: string;
    let stockityUserId: string;

    try {
      // Catat waktu attempt tepat sebelum request dikirim
      this.recordLoginAttempt(email);

      // LOGIN_PROXY dari .env digunakan di sini saja — request lain tidak lewat proxy
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
        LOGIN_PROXY || undefined,
      );

      if (result.status >= 400) {
        const body = result.data;
        this.logger.error(
          `Stockity login error [HTTP ${result.status}]: ` +
          `${JSON.stringify(body).slice(0, 500)}`,
        );

        // ── FIX: Handle 429 secara khusus — aktifkan blokir panjang ─────────
        if (result.status === 429) {
          this.applyRateLimitBlock(email);
          const errMsg: string =
            body?.errors?.[0]?.context?.message ||
            body?.errors?.[0]?.message          ||
            'Terlalu banyak percobaan login dari server. Coba lagi dalam beberapa menit.';
          throw new HttpException(errMsg, HttpStatus.TOO_MANY_REQUESTS);
        }

        const errMsg: string =
          body?.errors?.[0]?.context?.message ||
          body?.errors?.[0]?.message          ||
          body?.errors?.[0]                   ||
          body?.message                        ||
          body?.error                          ||
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
      if (err instanceof HttpException) throw err;

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

    // ── Simpan session ke Supabase ────────────────────────────────────────────
    // ✅ FIX: Cek error dari upsert — sebelumnya error diabaikan sehingga JWT
    //    diterbitkan meski session tidak tersimpan → semua request berikutnya 401.
    // ✅ FIX CURRENCY: Coba baca currency lama dari Supabase ATAU detect langsung
    //    dari Stockity (platform/private/v2/profile punya field 'currency').
    //    Prioritas: (1) Stockity API → (2) session lama → (3) default IDR
    let existingCurrency    = 'IDR';
    let existingCurrencyIso = 'IDR';
    let existingCountry     = '';

    // ── Prioritas 1: Detect dari Stockity langsung (paling akurat) ───────────
    // Dari HAR: platform/private/v2/profile → data.currency = "COP" untuk akun Colombia.
    // Ini lebih reliable dari session lama yang mungkin stale.
    try {
      const headers = {
        'device-id':           deviceId,
        'device-type':         'web',
        'user-timezone':       DEFAULT_TIMEZONE,
        'authorization-token': stockityAuthToken,
        'User-Agent':          DEFAULT_USER_AGENT,
        'Accept':              'application/json, text/plain, */*',
        'Origin':              'https://stockity.id',
        'Referer':             'https://stockity.id/',
      };
      const { curlGet: curlGetFn } = await import('../common/http-utils');
      const resp = await curlGetFn(`${BASE_URL}/platform/private/v2/profile?locale=id`, headers, 8);
      const profilePayload = resp?.data?.data ?? resp?.data ?? {};
      const detectedCurrency: string | undefined = profilePayload.currency;
      // ✅ FIX LANGUAGE: Ekstrak country dari profil Stockity untuk deteksi bahasa di frontend
      const detectedCountryRaw: string | undefined =
        profilePayload.country ?? profilePayload.registration_country_iso ?? profilePayload.registrationCountryIso;
      if (detectedCountryRaw) {
        existingCountry = detectedCountryRaw.toUpperCase();
        this.logger.log(
          `✅ Country terdeteksi dari Stockity profile: ${existingCountry} untuk userId=${stockityUserId}`,
        );
      }
      if (detectedCurrency) {
        existingCurrency    = detectedCurrency;
        existingCurrencyIso = detectedCurrency; // ISO code — unit/simbol di-resolve frontend
        this.logger.log(
          `✅ Currency terdeteksi dari Stockity profile: ${detectedCurrency} untuk userId=${stockityUserId}`,
        );
      }
    } catch (profileErr: any) {
      // Tidak fatal — fallback ke session lama di bawah
      this.logger.debug(`[CurrencyDetect] profile fetch gagal: ${profileErr?.message}`);
    }

    // ── Prioritas 2: Session lama jika detect dari Stockity gagal ────────────
    if (existingCurrency === 'IDR') {
      try {
        const { data: existingSession } = await this.supabaseService.client
          .from('sessions')
          .select('currency, currency_iso')
          .eq('user_id', stockityUserId)
          .maybeSingle();
        if (existingSession?.currency && existingSession.currency !== 'IDR') {
          existingCurrency    = existingSession.currency;
          existingCurrencyIso = existingSession.currency_iso ?? existingSession.currency;
          this.logger.log(
            `✅ Currency dari session lama: ${existingCurrency} untuk userId=${stockityUserId}`,
          );
        }
      } catch {
        // Tidak fatal — lanjut dengan default IDR
      }
    }

    const { error: upsertError } = await this.supabaseService.client
      .from('sessions')
      .upsert({
        user_id:        stockityUserId,
        email,
        PK:             password,
        stockity_token: stockityAuthToken,
        device_id:      deviceId,
        device_type:    'web',
        user_agent:     DEFAULT_USER_AGENT,
        user_timezone:  DEFAULT_TIMEZONE,
        // ✅ FIX CURRENCY: Gunakan currency yang terdeteksi (bukan hardcode IDR).
        currency:       existingCurrency,
        currency_iso:   existingCurrencyIso,
        // ✅ FIX LANGUAGE: simpan country agar dashboard/profile bisa deteksi bahasa
        ...(existingCountry ? { country: existingCountry } : {}),
        updated_at:     this.supabaseService.now(),
        // ✅ FIX: logged_out_at TIDAK di-include di upsert karena beberapa
        //    versi Supabase client skip null saat conflict update.
        //    Di-reset via explicit UPDATE di bawah supaya pasti NULL.
      });

    if (upsertError) {
      this.logger.error(
        `❌ Gagal upsert session ke Supabase untuk userId=${stockityUserId}: ` +
        `code=${upsertError.code} | message=${upsertError.message} | ` +
        `details=${upsertError.details} | hint=${upsertError.hint}`,
      );
      throw new UnauthorizedException(
        'Gagal menyimpan sesi ke server. Coba login ulang.',
      );
    }

    this.logger.log(`✅ Session upserted ke Supabase untuk userId=${stockityUserId}`);

    // ✅ FIX: Reset logged_out_at secara eksplisit via UPDATE terpisah.
    //    Ini memastikan field benar-benar NULL meski upsert conflict-update
    //    melewatkan null values.
    const { error: resetError } = await this.supabaseService.client
      .from('sessions')
      .update({ logged_out_at: null })
      .eq('user_id', stockityUserId);

    if (resetError) {
      // Tidak fatal — session sudah terupsert, hanya logged_out_at yang gagal.
      // Log warning supaya bisa di-debug, tapi lanjut proses login.
      this.logger.warn(
        `⚠️ Gagal reset logged_out_at untuk userId=${stockityUserId}: ` +
        `code=${resetError.code} | message=${resetError.message}`,
      );
    } else {
      this.logger.log(`✅ logged_out_at di-reset NULL untuk userId=${stockityUserId}`);
    }

    // Invalidate cache setelah write supaya request berikutnya baca dari DB
    this.invalidateSessionCache(stockityUserId);

    // ── FIX: Bersihkan rate limit block & cooldown setelah login sukses ───────
    // Login berhasil berarti kredensial valid — hapus blokir agar tidak
    // menghalangi login ulang yang sah di masa depan.
    this.rateLimitBlockUntil.delete(email);
    this.loginCooldown.delete(email);

    const jwt = this.jwtService.sign({ sub: stockityUserId, email });
    this.logger.log(`✅ Login berhasil: ${email} (userId: ${stockityUserId})`);

    return {
      accessToken: jwt,
      userId:      stockityUserId,
      email,
      deviceId,
      // ✅ FIX LANGUAGE: kirim country ke frontend agar runSplash bisa deteksi bahasa
      // tanpa perlu extra round-trip ke api.getProfile()
      country: existingCountry,
    };
  }

  async logout(userId: string) {
    const { error } = await this.supabaseService.client
      .from('sessions')
      .update({ logged_out_at: this.supabaseService.now() })
      .eq('user_id', userId);

    if (error) {
      this.logger.warn(`Gagal update logged_out_at saat logout userId=${userId}: ${error.message}`);
    }

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
    if (cached) return cached;

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