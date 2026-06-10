import { Injectable, Logger, UnauthorizedException, HttpException, HttpStatus, BadRequestException, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SupabaseService } from '../supabase/supabase.service';
import { execFile } from 'child_process';
import { v4 as uuidv4 } from 'uuid';

const BASE_URL = 'https://api.stockity.id';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const DEFAULT_TIMEZONE = 'Asia/Bangkok';

/**
 * Proxy untuk request login ke Stockity (dibaca per-request via resolveLoginProxy).
 * Isi di .env:
 *   LOGIN_PROXY=socks5h://user:pass@host:port   (proxy residensial ID)
 *   LOGIN_PROXY_STICKY_RANGE=10001-20000        (opsional → IP sticky per-user)
 * Kosongkan LOGIN_PROXY untuk tidak pakai proxy.
 */

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
export class AuthService implements OnModuleDestroy {
  private readonly logger = new Logger(AuthService.name);

  /**
   * Interval pembersih Map in-memory agar tidak bocor memori (H3).
   * sessionCache/loginCooldown/rateLimitBlockUntil sebelumnya hanya dihapus
   * pada path sukses — email yang terus gagal (mis. brute-force) menumpuk
   * selamanya hingga OOM. Cleanup berkala membuang entri yang sudah kedaluwarsa.
   */
  private readonly cleanupTimer: NodeJS.Timeout;

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

  /**
   * Cache kode referral Stockity dari app_config (key `registration`).
   * Admin mengatur kode ini di panel; di-cache singkat agar tiap registrasi
   * tidak query DB berulang. Fallback ke env STOCKITY_REFERRAL bila kosong.
   */
  private referralCache: { code: string; expiresAt: number } | null = null;
  private readonly REFERRAL_CACHE_TTL_MS = 60_000;

  constructor(
    private jwtService: JwtService,
    private supabaseService: SupabaseService,
  ) {
    // Purge entri kedaluwarsa setiap 5 menit. unref() agar timer tidak
    // menahan proses keluar saat shutdown.
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 5 * 60_000);
    this.cleanupTimer.unref?.();
  }

  onModuleDestroy() {
    clearInterval(this.cleanupTimer);
  }

  /**
   * Buang entri kedaluwarsa dari semua Map in-memory (H3 — cegah memory leak).
   */
  private cleanupExpired() {
    const now = Date.now();
    let purged = 0;

    for (const [userId, entry] of this.sessionCache.entries()) {
      if (now >= entry.expiresAt) { this.sessionCache.delete(userId); purged++; }
    }
    for (const [email, ts] of this.loginCooldown.entries()) {
      if (now - ts >= LOGIN_COOLDOWN_MS) { this.loginCooldown.delete(email); purged++; }
    }
    for (const [email, until] of this.rateLimitBlockUntil.entries()) {
      if (now >= until) { this.rateLimitBlockUntil.delete(email); purged++; }
    }

    if (purged > 0) {
      this.logger.debug(`[cleanup] ${purged} entri cache/cooldown kedaluwarsa dibuang`);
    }
  }

  /**
   * Redaksi data sensitif sebelum masuk log (M6): token, UUID, email, password.
   * Mencegah PII/kredensial bocor ke logs/out.log.
   */
  private redact(s: string): string {
    return s
      .replace(/("?(?:authtoken|authorization-token|stockity_token|token|password|PK)"?\s*[:=]\s*)"?[^",}\s]+"?/gi, '$1"<REDACTED>"')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '<EMAIL>');
  }

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

  // ── Proxy login per-user (sticky IP) ──────────────────────────────────────
  /**
   * Hash deterministik (FNV-1a 32-bit) untuk memetakan email → port sticky.
   * Stabil lintas restart/proses, sehingga 1 user selalu dapat IP yang sama.
   */
  private stickyHash(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /**
   * Tentukan proxy untuk login user ini.
   * - Env dibaca SAAT REQUEST (bukan module-load) agar `pm2 reload` langsung terpakai.
   * - LOGIN_PROXY kosong  → tanpa proxy (undefined).
   * - LOGIN_PROXY_STICKY_RANGE="10001-20000" → port di-replace per-email
   *   (tiap user = port tetap = IP residensial sticky sendiri).
   * - Tanpa range → pakai LOGIN_PROXY apa adanya (port rotating dari provider).
   */
  private resolveLoginProxy(email: string): string | undefined {
    const base = (process.env.LOGIN_PROXY ?? '').trim();
    if (!base) return undefined;

    const range = (process.env.LOGIN_PROXY_STICKY_RANGE ?? '').trim();
    const m = range.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!m) return base;

    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return base;

    const port = start + (this.stickyHash(email.toLowerCase().trim()) % (end - start + 1));
    // Ganti port di akhir URL (scheme://[user:pass@]host:PORT) → port sticky per-user.
    return /:\d+$/.test(base) ? base.replace(/:\d+$/, `:${port}`) : `${base}:${port}`;
  }

  // ── curlPost ──────────────────────────────────────────────────────────────
  // Gunakan curl binary (bukan axios) untuk bypass Cloudflare JA3/JA4 fingerprint
  // blocking. Node.js/axios memiliki TLS fingerprint berbeda dari browser/curl,
  // sehingga Cloudflare silently hang koneksinya (ETIMEDOUT, no response).
  // curl dari VPS ini terbukti lolos (HTTP 422 pada test dengan kredensial salah).
  //
  // ── Keamanan (H2) ─────────────────────────────────────────────────────────
  // URL, header, dan body (PASSWORD!) dikirim via config curl lewat STDIN
  // (`curl -K -`), BUKAN argumen CLI — kredensial tidak bocor ke `ps aux`.
  private async curlPost(
    url: string,
    body: object,
    headers: Record<string, string>,
    proxy?: string,
  ): Promise<{ status: number; data: any }> {
    const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const lines: string[] = [
      'silent',
      'show-error',
      'request = "POST"',
      `url = "${esc(url)}"`,
    ];
    for (const [k, v] of Object.entries(headers)) {
      lines.push(`header = "${esc(`${k}: ${v}`)}"`);
    }
    lines.push('header = "Content-Type: application/json"');
    lines.push(`data-raw = "${esc(JSON.stringify(body))}"`);
    lines.push('max-time = 15');
    if (proxy) {
      lines.push(`proxy = "${esc(proxy)}"`);
      this.logger.debug(`curlPost via proxy → ${url}`);
    }
    lines.push('write-out = "__HTTP_STATUS__%{http_code}"');
    const config = lines.join('\n') + '\n';

    const stdout = await new Promise<string>((resolve, reject) => {
      const cp = execFile(
        'curl',
        ['-K', '-'],
        { maxBuffer: 20 * 1024 * 1024, timeout: 20_000 },
        (err, out) => {
          if (out) return resolve(out);
          if (err) return reject(err);
          resolve(out ?? '');
        },
      );
      cp.stdin?.end(config);
    });

    const idx        = stdout.lastIndexOf('__HTTP_STATUS__');
    const rawBody    = (idx >= 0 ? stdout.slice(0, idx) : stdout).trim();
    const statusCode = idx >= 0 ? parseInt(stdout.slice(idx + '__HTTP_STATUS__'.length).trim(), 10) : 0;

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

      // Proxy login per-user (sticky IP). Hanya request login yang lewat proxy.
      const loginProxy = this.resolveLoginProxy(email);
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
        loginProxy,
      );

      if (result.status >= 400) {
        const body = result.data;
        this.logger.error(
          `Stockity login error [HTTP ${result.status}]: ` +
          `${this.redact(JSON.stringify(body)).slice(0, 500)}`,
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
          `Body: ${this.redact(JSON.stringify(d)).slice(0, 300)}`,
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
      const detectedCurrency: string | undefined = resp?.data?.data?.currency;
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

    // ── Masa aktif: tolak login jika expires_at sudah lewat (+ nonaktifkan) ───
    try {
      const emailLc = email.toLowerCase().trim();
      const { data: wl } = await this.supabaseService.client
        .from('whitelist_users')
        .select('expires_at')
        .eq('email', emailLc)
        .maybeSingle();
      if (wl?.expires_at && new Date(wl.expires_at).getTime() < Date.now()) {
        await this.supabaseService.client
          .from('whitelist_users')
          .update({ is_active: false })
          .eq('email', emailLc);
        throw new UnauthorizedException(
          'Masa aktif akun Anda telah habis. Silakan hubungi super-admin untuk perpanjangan.',
        );
      }
    } catch (e: any) {
      if (e instanceof UnauthorizedException) throw e;
      // error non-fatal lain: abaikan, jangan blokir login
    }

    // ── C2: update last_login whitelist di server (service_role) ──────────────
    // Menggantikan updateLastLogin() yang dulu dipanggil frontend via anon key
    // (kini diblokir RLS). Best-effort — kegagalan tidak menggagalkan login.
    try {
      await this.supabaseService.client
        .from('whitelist_users')
        .update({ last_login: this.supabaseService.now() })
        .eq('email', email.toLowerCase().trim());
    } catch (e: any) {
      this.logger.warn(`Gagal update last_login untuk login ${email}: ${e?.message}`);
    }

    const jwt = this.jwtService.sign({ sub: stockityUserId, email });
    this.logger.log(`✅ Login berhasil: ${email} (userId: ${stockityUserId})`);

    return {
      accessToken: jwt,
      userId:      stockityUserId,
      email,
      deviceId,
    };
  }

  /**
   * Generate track_token sesuai format Stockity: `YYYYMMDD_<uuid>`.
   * Dibutuhkan oleh endpoint sign_up & oauth/web (validasi `{invalid.track.token}`).
   */
  private buildTrackToken(): string {
    const d = new Date();
    const ymd =
      d.getUTCFullYear().toString() +
      String(d.getUTCMonth() + 1).padStart(2, '0') +
      String(d.getUTCDate()).padStart(2, '0');
    return `${ymd}_${uuidv4()}`;
  }

  /**
   * Registrasi akun Stockity langsung dari aplikasi (inline, tanpa webview).
   * Proxy ke `POST /passport/v1/sign_up` — body sama seperti web client:
   *   { email, password, currency, i_agree, track_token }
   * Atribusi referral dikirim via cookie `a=<kode>` (STOCKITY_REFERRAL),
   * sama seperti web yang menyimpan cookie afiliasi saat membuka link referral.
   *
   * Sukses → response { data: { authtoken, user_id } } (identik dengan login).
   * Setelah itu: simpan session (PK=password), daftarkan whitelist, terbitkan JWT.
   */
  /**
   * Resolusi kode referral/afiliasi Stockity (cookie `a`).
   * Prioritas: app_config.registration.stockityReferral (diatur admin di panel)
   * → env STOCKITY_REFERRAL → default '8620c08b51a6'. Di-cache singkat.
   */
  private async resolveStockityReferral(): Promise<string> {
    const fallback = (process.env.STOCKITY_REFERRAL ?? '8620c08b51a6').trim();

    const now = Date.now();
    if (this.referralCache && now < this.referralCache.expiresAt) {
      return this.referralCache.code;
    }

    let code = fallback;
    try {
      const { data } = await this.supabaseService.client
        .from('app_config')
        .select('value')
        .eq('key', 'registration')
        .maybeSingle();

      const raw = data?.value;
      const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const configured = String(v?.stockityReferral ?? '').trim();
      if (configured) code = configured;
    } catch (e: any) {
      this.logger.warn(`resolveStockityReferral: gagal baca config, pakai fallback: ${e?.message}`);
    }

    this.referralCache = { code, expiresAt: now + this.REFERRAL_CACHE_TTL_MS };
    return code;
  }

  /**
   * Daftarkan "kunjungan" referral ke Stockity traffic-tracker — INILAH yang
   * mengikat afiliasi ke `device_id` dan menaikkan statistik pengunjung afiliasi
   * (terbukti dari HAR: `POST /traffic-tracker/v1/track?a=<tag>&t=0&locale=id`,
   * header `device-id`, body `{}`, respons 201). Kode afiliasi ada di query
   * string, bukan cookie. sign_up berikutnya dengan device_id yang sama →
   * ter-atribusi ke referral.
   *
   * Mengembalikan `track_token` dari respons (terikat ke afiliasi+device) yang
   * WAJIB dipakai sebagai track_token saat sign_up agar registrasi ter-atribusi.
   * Best-effort: null jika gagal (caller fallback ke token generate sendiri).
   */
  private async fireTrafficTracker(
    deviceId: string,
    referral: string,
    proxy?: string,
  ): Promise<string | null> {
    const url =
      `${BASE_URL}/traffic-tracker/v1/track` +
      `?a=${encodeURIComponent(referral)}&t=0&locale=id`;

    const headers: Record<string, string> = {
      'device-id':     deviceId,
      'device-type':   'web',
      'user-timezone': DEFAULT_TIMEZONE,
      'accept':        'application/json, text/plain, */*',
      'User-Agent':    DEFAULT_USER_AGENT,
      'Origin':        'https://stockity.id',
      'Referer':       'https://stockity.id/',
    };

    try {
      const { status, body } = await this.curlTrack(url, {}, headers, proxy);
      let trackToken: string | null = null;
      try { trackToken = JSON.parse(body)?.data?.track_token ?? null; } catch { /* non-JSON */ }
      this.logger.log(
        `traffic-tracker resp: status=${status} device=${deviceId} ` +
        `track_token=${trackToken ? 'ada' : 'KOSONG'}`,
      );
      return trackToken;
    } catch (e: any) {
      this.logger.warn(`fireTrafficTracker gagal: ${e?.message}`);
      return null;
    }
  }

  /**
   * POST JSON yang MENGEMBALIKAN status + body mentah (tanpa parse JSON, tanpa
   * melempar pada body kosong). Dipakai untuk traffic-tracker agar kita bisa
   * melihat apakah Stockity benar-benar menerima (201) atau menolak.
   */
  private async curlTrack(
    url: string,
    body: object,
    headers: Record<string, string>,
    proxy?: string,
  ): Promise<{ status: number; body: string }> {
    const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const lines: string[] = [
      'silent',
      'show-error',
      'request = "POST"',
      `url = "${esc(url)}"`,
    ];
    for (const [k, v] of Object.entries(headers)) {
      lines.push(`header = "${esc(`${k}: ${v}`)}"`);
    }
    lines.push('header = "Content-Type: application/json"');
    lines.push(`data-raw = "${esc(JSON.stringify(body))}"`);
    lines.push('max-time = 10');
    if (proxy) lines.push(`proxy = "${esc(proxy)}"`);
    lines.push('write-out = "__HTTP_STATUS__%{http_code}"');
    const config = lines.join('\n') + '\n';

    const stdout = await new Promise<string>((resolve) => {
      const cp = execFile(
        'curl',
        ['-K', '-'],
        { maxBuffer: 4 * 1024 * 1024, timeout: 12_000 },
        (_err, out) => resolve(out ?? ''),  // best-effort
      );
      cp.stdin?.end(config);
    });

    const idx    = stdout.lastIndexOf('__HTTP_STATUS__');
    const body2  = (idx >= 0 ? stdout.slice(0, idx) : stdout).trim();
    const status = idx >= 0 ? parseInt(stdout.slice(idx + '__HTTP_STATUS__'.length).trim(), 10) : 0;
    return { status, body: body2 };
  }

  async register(email: string, password: string, currency = 'IDR') {
    const emailLc = email.toLowerCase().trim();
    this.logger.log(`Register attempt: ${emailLc}`);

    // Reuse cooldown anti-spam yang sama dengan login (per email/IP throttle di controller).
    this.checkLoginRateLimit(emailLc);

    // Akun baru → deviceId baru. Samakan format dengan web Stockity: 32 hex
    // tanpa strip (mis. e1beefb980624a954ea96efd30d6e705), bukan UUID berstrip,
    // agar binding traffic-tracker → sign_up konsisten dengan device asli.
    let deviceId = uuidv4().replace(/-/g, '');
    try {
      const { data: existing } = await this.supabaseService.client
        .from('sessions')
        .select('device_id')
        .eq('email', emailLc)
        .limit(1)
        .maybeSingle();
      if (existing?.device_id) deviceId = existing.device_id;
    } catch { /* pakai deviceId baru */ }

    // Kode referral diatur admin di panel (app_config) → dinamis tanpa redeploy.
    const referral = await this.resolveStockityReferral();
    this.logger.log(`Register referral aktif: ${referral || '(kosong)'}`);

    let stockityAuthToken: string;
    let stockityUserId: string;

    try {
      this.recordLoginAttempt(emailLc);

      const signupProxy = this.resolveLoginProxy(emailLc);

      // ── Atribusi afiliasi ─────────────────────────────────────────────────
      // Traffic-tracker (query string `?a=`) menerbitkan `track_token` yang
      // terikat ke afiliasi+device. Token INILAH yang harus dipakai saat
      // sign_up agar registrasi ter-atribusi — bukan token generate sendiri.
      // Best-effort: kalau gagal, fallback ke buildTrackToken (signup tetap
      // jalan, hanya tidak ter-atribusi).
      const affiliateToken = referral
        ? await this.fireTrafficTracker(deviceId, referral, signupProxy)
        : null;
      const trackToken = affiliateToken ?? this.buildTrackToken();

      const result = await this.curlPost(
        `${BASE_URL}/passport/v1/sign_up?locale=id`,
        { email: emailLc, password, currency, i_agree: true, track_token: trackToken },
        {
          'device-id':     deviceId,
          'device-type':   'web',
          'user-timezone': DEFAULT_TIMEZONE,
          'accept':        'application/json, text/plain, */*',
          'User-Agent':    DEFAULT_USER_AGENT,
          'Origin':        'https://stockity.id',
          'Referer':       'https://stockity.id/',
          // Atribusi afiliasi/referral (cookie `a`), sama seperti web client.
          ...(referral ? { 'Cookie': `a=${referral}` } : {}),
        },
        signupProxy,
      );

      if (result.status >= 400) {
        const body = result.data;
        this.logger.error(
          `Stockity sign_up error [HTTP ${result.status}]: ` +
          `${this.redact(JSON.stringify(body)).slice(0, 500)}`,
        );

        if (result.status === 429) {
          this.applyRateLimitBlock(emailLc);
          throw new HttpException(
            'Terlalu banyak percobaan. Coba lagi dalam beberapa menit.',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }

        // Bentuk error Stockity: { errors: [{ code, context: { field, message } }] }
        const errObj = body?.errors?.[0];
        const rawMsg: string =
          errObj?.context?.message ||
          errObj?.message ||
          body?.message ||
          '';
        const code: string = errObj?.code || '';

        // Pesan ramah untuk kasus umum.
        let friendly = rawMsg;
        if (/already|exist|taken|registered/i.test(rawMsg) || /Email/i.test(code) && /taken|exist/i.test(rawMsg)) {
          friendly = 'Email sudah terdaftar. Silakan login.';
        } else if (/password/i.test(code) || /password/i.test(rawMsg)) {
          friendly = rawMsg || 'Password tidak memenuhi syarat.';
        } else if (!friendly) {
          friendly = 'Registrasi gagal. Periksa data Anda lalu coba lagi.';
        }
        throw new BadRequestException(friendly);
      }

      const d = result.data?.data ?? {};
      stockityAuthToken = d.authtoken ?? '';
      stockityUserId    = String(d.user_id ?? d.userId ?? '');

      if (!stockityAuthToken || !stockityUserId) {
        this.logger.error(
          `sign_up sukses tapi token/user_id kosong. keys=[${Object.keys(d).join(', ')}]`,
        );
        throw new BadRequestException('Registrasi gagal: respons tidak lengkap dari server.');
      }
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      const errCode = err?.code ?? 'unknown';
      this.logger.error(`Stockity sign_up error: code=${errCode} msg=${err?.message}`);
      const errMsg =
        errCode === 'ETIMEDOUT'    ? 'Koneksi ke Stockity timeout, coba lagi' :
        errCode === 'ECONNREFUSED' ? 'Tidak bisa terhubung ke Stockity'       :
        err?.message || 'Registrasi gagal';
      throw new BadRequestException(errMsg);
    }

    // ── Simpan session (PK=password agar bot bisa re-auth, sama seperti login) ──
    const { error: upsertError } = await this.supabaseService.client
      .from('sessions')
      .upsert({
        user_id:        stockityUserId,
        email:          emailLc,
        PK:             password,
        stockity_token: stockityAuthToken,
        device_id:      deviceId,
        device_type:    'web',
        user_agent:     DEFAULT_USER_AGENT,
        user_timezone:  DEFAULT_TIMEZONE,
        currency:       currency,
        currency_iso:   currency,
        updated_at:     this.supabaseService.now(),
      });

    if (upsertError) {
      this.logger.error(
        `❌ Gagal upsert session register userId=${stockityUserId}: ${upsertError.message}`,
      );
      throw new BadRequestException('Gagal menyimpan sesi. Coba login dengan akun baru Anda.');
    }

    await this.supabaseService.client
      .from('sessions')
      .update({ logged_out_at: null })
      .eq('user_id', stockityUserId);

    this.invalidateSessionCache(stockityUserId);
    this.rateLimitBlockUntil.delete(emailLc);
    this.loginCooldown.delete(emailLc);

    // ── Daftarkan ke whitelist (best-effort, validasi via token) ──────────────
    try {
      await this.registerWhitelistFromToken(stockityAuthToken, deviceId, {
        isPrimary: false,
        addedBy:   'self-register',
      });
    } catch (e: any) {
      // Tidak fatal — akun Stockity sudah dibuat & session tersimpan.
      this.logger.warn(`register: whitelist gagal untuk ${emailLc}: ${e?.message}`);
    }

    const jwt = this.jwtService.sign({ sub: stockityUserId, email: emailLc });
    this.logger.log(`✅ Register berhasil: ${emailLc} (userId: ${stockityUserId})`);

    return {
      accessToken: jwt,
      userId:      stockityUserId,
      email:       emailLc,
      deviceId,
    };
  }

  /**
   * Registrasi whitelist tervalidasi token (C2).
   * Dipakai alur registrasi (manual & webview) yang sebelumnya menulis
   * whitelist_users langsung dari browser. Token Stockity divalidasi ke
   * Stockity profile (membuktikan kepemilikan akun) → lalu tulis via service_role.
   * Idempoten: jika email sudah ada → hanya update last_login.
   */
  async registerWhitelistFromToken(
    authToken: string,
    deviceId: string,
    payload: { name?: string; isPrimary?: boolean; addedBy?: string },
  ): Promise<{ email: string; userId: string; isActive: boolean; exists: boolean }> {
    if (!authToken) throw new UnauthorizedException('Token Stockity diperlukan');

    let email = '';
    let userId = '';
    let fullName = (payload?.name ?? '').trim();
    try {
      const { curlGet } = await import('../common/http-utils');
      const headers = {
        'device-id':           deviceId || '',
        'device-type':         'web',
        'user-timezone':       DEFAULT_TIMEZONE,
        'authorization-token': authToken,
        'User-Agent':          DEFAULT_USER_AGENT,
        'Accept':              'application/json, text/plain, */*',
        'Origin':              'https://stockity.id',
        'Referer':             'https://stockity.id/',
      };
      const resp = await curlGet(`${BASE_URL}/platform/private/v2/profile?locale=id`, headers, 8);
      const d = resp?.data?.data ?? {};
      email  = String(d.email ?? '').toLowerCase().trim();
      userId = String(d.id ?? '');
      if (!fullName) fullName = [d.first_name, d.last_name].filter(Boolean).join(' ') || (d.nickname ?? '');
    } catch (e: any) {
      this.logger.warn(`registerWhitelist: validasi token gagal: ${e?.message}`);
      throw new UnauthorizedException('Token Stockity tidak valid');
    }
    if (!email || !userId) throw new UnauthorizedException('Gagal memvalidasi akun Stockity');

    const { data: existing } = await this.supabaseService.client
      .from('whitelist_users')
      .select('email, is_active')
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      await this.supabaseService.client
        .from('whitelist_users')
        .update({ last_login: this.supabaseService.now() })
        .eq('email', email);
      return { email, userId, isActive: existing.is_active ?? false, exists: true };
    }

    const { error } = await this.supabaseService.client.from('whitelist_users').insert({
      email,
      is_active:  true,
      is_primary: payload?.isPrimary ?? false,
      added_at:   this.supabaseService.now(),
      added_by:   payload?.addedBy ?? 'system',
      name:       fullName || null,
      user_id:    userId,
      device_id:  deviceId || userId,
      last_login: this.supabaseService.now(),
    });
    if (error) throw new BadRequestException('Gagal mendaftarkan whitelist: ' + error.message);

    return { email, userId, isActive: true, exists: false };
  }

  /**
   * Buat sesi aplikasi dari authtoken Stockity yang sudah ada (login Google).
   * Token didapat dari in-app WebView (plugin StcWebView membaca DOM callback OAuth).
   * Alur: validasi token via profile → upsert session (tanpa PK, akun OAuth tak
   * punya password) → whitelist idempoten → cek masa aktif → terbitkan JWT.
   */
  async sessionFromToken(authToken: string, deviceId?: string) {
    if (!authToken) throw new UnauthorizedException('Token Stockity diperlukan');

    let email = '';
    let userId = '';
    let currency = 'IDR';
    let did = (deviceId ?? '').trim();

    // ── Validasi token + ambil profil (email, user_id, currency) ─────────────
    try {
      const { curlGet } = await import('../common/http-utils');
      const headers = {
        'device-id':           did || '',
        'device-type':         'web',
        'user-timezone':       DEFAULT_TIMEZONE,
        'authorization-token': authToken,
        'User-Agent':          DEFAULT_USER_AGENT,
        'Accept':              'application/json, text/plain, */*',
        'Origin':              'https://stockity.id',
        'Referer':             'https://stockity.id/',
      };
      const resp = await curlGet(`${BASE_URL}/platform/private/v2/profile?locale=id`, headers, 8);
      const d = resp?.data?.data ?? {};
      email  = String(d.email ?? '').toLowerCase().trim();
      userId = String(d.id ?? '');
      if (d.currency) currency = String(d.currency);
    } catch (e: any) {
      this.logger.warn(`sessionFromToken: validasi token gagal: ${e?.message}`);
      throw new UnauthorizedException('Token Stockity tidak valid');
    }
    if (!email || !userId) throw new UnauthorizedException('Gagal memvalidasi akun Stockity');

    // deviceId: pakai yang dikirim, atau reuse session lama, atau buat baru.
    if (!did) {
      try {
        const { data: ex } = await this.supabaseService.client
          .from('sessions')
          .select('device_id')
          .eq('user_id', userId)
          .maybeSingle();
        did = ex?.device_id || uuidv4();
      } catch { did = uuidv4(); }
    }

    // ── Upsert session (TANPA PK — akun Google tak punya password) ───────────
    const { error: upsertError } = await this.supabaseService.client
      .from('sessions')
      .upsert({
        user_id:        userId,
        email,
        stockity_token: authToken,
        device_id:      did,
        device_type:    'web',
        user_agent:     DEFAULT_USER_AGENT,
        user_timezone:  DEFAULT_TIMEZONE,
        currency,
        currency_iso:   currency,
        updated_at:     this.supabaseService.now(),
      });
    if (upsertError) {
      this.logger.error(`❌ Gagal upsert session (google) userId=${userId}: ${upsertError.message}`);
      throw new UnauthorizedException('Gagal menyimpan sesi. Coba lagi.');
    }

    await this.supabaseService.client
      .from('sessions')
      .update({ logged_out_at: null })
      .eq('user_id', userId);
    this.invalidateSessionCache(userId);

    // ── Whitelist idempoten (daftar bila baru, update last_login bila ada) ───
    try {
      await this.registerWhitelistFromToken(authToken, did, {
        isPrimary: false,
        addedBy:   'google-login',
      });
    } catch (e: any) {
      this.logger.warn(`sessionFromToken: whitelist gagal untuk ${email}: ${e?.message}`);
    }

    // ── Masa aktif: tolak bila sudah lewat (+ nonaktifkan), sama seperti login ─
    try {
      const { data: wl } = await this.supabaseService.client
        .from('whitelist_users')
        .select('expires_at')
        .eq('email', email)
        .maybeSingle();
      if (wl?.expires_at && new Date(wl.expires_at).getTime() < Date.now()) {
        await this.supabaseService.client
          .from('whitelist_users')
          .update({ is_active: false })
          .eq('email', email);
        throw new UnauthorizedException(
          'Masa aktif akun Anda telah habis. Silakan hubungi super-admin untuk perpanjangan.',
        );
      }
    } catch (e: any) {
      if (e instanceof UnauthorizedException) throw e;
    }

    const jwt = this.jwtService.sign({ sub: userId, email });
    this.logger.log(`✅ Login Google berhasil: ${email} (userId: ${userId})`);

    return { accessToken: jwt, userId, email, deviceId: did };
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