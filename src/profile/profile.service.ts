import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { curlGet } from '../common/http-utils';

const BASE_URL = 'https://api.stockity.id';

@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);

  /**
   * In-memory cache untuk session data agar tidak read Firestore berkali-kali.
   * TTL: 30 detik — selaras dengan AuthService session cache.
   */
  private sessionCache = new Map<string, { data: any; expiresAt: number }>();
  private readonly SESSION_CACHE_TTL_MS = 30_000;

  constructor(private supabaseService: SupabaseService) {}

  private async getSession(userId: string) {
    const cached = this.sessionCache.get(userId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }

    const { data, error } = await this.supabaseService.client
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error || !data) throw new Error('Session tidak ditemukan');

    this.sessionCache.set(userId, {
      data,
      expiresAt: Date.now() + this.SESSION_CACHE_TTL_MS,
    });
    return data;
  }

  private buildHeaders(session: any): Record<string, string> {
    return {
      'device-id': session.device_id,
      'device-type': session.device_type || 'web',
      'user-timezone': session.user_timezone || 'Asia/Jakarta',
      'authorization-token': session.stockity_token,
      'User-Agent': session.user_agent,
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://stockity.id',
      'Referer': 'https://stockity.id/',
    };
  }

  /**
   * Map raw Stockity snake_case profile data → camelCase shape yang diexpect frontend.
   *
   * Root cause: Stockity API mengembalikan snake_case (first_name, email_verified, dst).
   * Backend selama ini return raw data → frontend baca undefined karena key tidak cocok.
   *
   * Merge v2 + v1 data:
   *   - v2 (platform/private/v2/profile) → sumber utama: currency, first_name, email_verified, dll
   *   - v1 (passport/v1/user_profile)    → suplemen: registration_country_iso, personal_data_locked
   */
  private mapProfileData(v2Data: any, v1Data: any): Record<string, unknown> {
    const src = v2Data ?? v1Data ?? {};
    const sup = (!v2Data && v1Data) ? {} : (v1Data ?? {}); // supplement dari v1

    return {
      id:                     src.id,
      email:                  src.email,
      firstName:              src.first_name  ?? null,
      lastName:               src.last_name   ?? null,
      nickname:               src.nickname    ?? null,
      phone:                  src.phone       ?? null,
      gender:                 src.gender      ?? null,
      country:                src.country     ?? null,
      birthday:               src.birthday    || null,
      currency:               src.currency    ?? null,
      avatar:                 src.avatar      ?? null,
      emailVerified:          src.email_verified          ?? false,
      phoneVerified:          src.phone_verified          ?? false,
      docsVerified:           src.docs_verified           ?? false,
      registeredAt:           src.registered_at           ?? null,
      // registration_country_iso hanya ada di v1 — suplemen dari v1 jika tersedia
      registrationCountryIso: src.registration_country_iso
                                ?? sup.registration_country_iso
                                ?? src.country
                                ?? null,
      // personal_data_locked hanya ada di v1
      personalDataLocked:     src.personal_data_locked
                                ?? sup.personal_data_locked
                                ?? false,
    };
  }

  /**
   * ✅ FIX CURRENCY + FIX SNAKE_CASE: getProfile sekarang pakai dua endpoint secara paralel:
   *   1. platform/private/v2/profile  → sumber utama: currency, first_name, email_verified, dll
   *   2. passport/v1/user_profile     → suplemen: registration_country_iso, personal_data_locked
   *
   * Setelah dapat profile, data di-map ke camelCase sebelum dikembalikan ke frontend,
   * agar frontend bisa baca firstName, emailVerified, dst tanpa undefined.
   */
  async getProfile(userId: string) {
    const session = await this.getSession(userId);
    const headers = this.buildHeaders(session);

    // ── Fetch kedua endpoint paralel ──────────────────────────────────────
    const [v2Result, v1Result] = await Promise.allSettled([
      curlGet(`${BASE_URL}/platform/private/v2/profile?locale=id`, headers, 10),
      curlGet(`${BASE_URL}/passport/v1/user_profile?locale=id`, headers, 10),
    ]);

    // Ambil data mentah dari masing-masing endpoint
    const v2Data: any = v2Result.status === 'fulfilled'
      ? (v2Result.value?.data?.data ?? v2Result.value?.data ?? null)
      : null;
    const v1Data: any = v1Result.status === 'fulfilled'
      ? (v1Result.value?.data?.data ?? v1Result.value?.data ?? null)
      : null;

    if (!v2Data && !v1Data) {
      this.logger.error(`getProfile error: kedua endpoint gagal`);
      throw new Error('Gagal mengambil profil dari Stockity');
    }

    // ── Auto-sync currency ke session jika masih IDR ──────────────────────
    const profileCurrency: string | undefined = v2Data?.currency;
    if (profileCurrency && profileCurrency !== 'IDR' &&
        (session.currency === 'IDR' || !session.currency)) {
      this.logger.log(
        `✅ Auto-sync currency dari profile: ${session.currency ?? 'null'} → ${profileCurrency} ` +
        `untuk userId=${userId}`,
      );
      await this.supabaseService.client
        .from('sessions')
        .update({ currency: profileCurrency, currency_iso: profileCurrency, updated_at: this.supabaseService.now() })
        .eq('user_id', userId);
      this.sessionCache.delete(userId);
    }

    // ── Map snake_case → camelCase sebelum return ke frontend ────────────
    return this.mapProfileData(v2Data, v1Data);
  }

  async getBalance(userId: string) {
    const session = await this.getSession(userId);
    try {
      const resp = await curlGet(
        `${BASE_URL}/bank/v1/read?locale=id`,
        { ...this.buildHeaders(session), 'Cache-Control': 'no-cache' },
        10, // timeout 10s
      );
      const data: any[] = resp.data?.data || [];
      const real = data.find((d) => d.account_type === 'real');
      const demo = data.find((d) => d.account_type === 'demo');

      // ✅ FIX CURRENCY: Prioritaskan currency dari bank/v1/read (source of truth dari Stockity).
      // Dari HAR: bank/v1/read mengembalikan currency: "COP" langsung dari Stockity.
      // Jangan fallback ke session.currency (mungkin masih 'IDR').
      const detectedCurrency = real?.currency ?? demo?.currency ?? session.currency ?? 'IDR';

      // Auto-sync ke session jika berbeda
      if (detectedCurrency !== 'IDR' && detectedCurrency !== session.currency) {
        this.logger.log(
          `✅ Auto-sync currency dari balance: ${session.currency} → ${detectedCurrency} ` +
          `untuk userId=${userId}`,
        );
        await this.supabaseService.client
          .from('sessions')
          .update({ currency: detectedCurrency, currency_iso: detectedCurrency, updated_at: this.supabaseService.now() })
          .eq('user_id', userId);
        this.sessionCache.delete(userId);
      }

      return {
        real_balance: real?.balance ?? 0,
        demo_balance: demo?.balance ?? 0,
        balance: real?.balance ?? 0,
        currency: detectedCurrency,
      };
    } catch (err: any) {
      this.logger.error(`getBalance error: ${err.message}`);
      throw new Error('Gagal mengambil balance dari Stockity');
    }
  }

  async getCurrencies(userId: string) {
    const session = await this.getSession(userId);
    try {
      const resp = await curlGet(
        `${BASE_URL}/platform/private/v2/currencies?locale=id`,
        { ...this.buildHeaders(session), 'cache-control': 'no-cache' },
        10, // timeout 10s
      );
      return resp.data?.data || resp.data;
    } catch (err: any) {
      throw new Error('Gagal mengambil currencies dari Stockity');
    }
  }

  async getAssets(userId: string) {
    const session = await this.getSession(userId);
    try {
      const resp = await curlGet(
        `${BASE_URL}/bo-assets/v6/assets?locale=id`,
        this.buildHeaders(session),
        15, // timeout 15s
      );
      const raw: any[] = resp.data?.data?.assets || [];
      return raw
        .map((a) => {
          let profitRate: number | null = null;
          for (const r of a.personal_user_payment_rates || []) {
            if (r.trading_type === 'turbo') { profitRate = r.payment_rate; break; }
          }
          if (profitRate === null) {
            profitRate =
              a.trading_tools_settings?.ftt?.user_statuses?.vip?.payment_rate_turbo ??
              a.trading_tools_settings?.bo?.payment_rate_turbo ??
              a.trading_tools_settings?.payment_rate_turbo ?? null;
          }
          if (profitRate === null) return null;
          return { ric: a.ric, name: a.name, type: a.type, profitRate, iconUrl: a.icon?.url ?? null };
        })
        .filter(Boolean)
        .sort((a: any, b: any) => b.profitRate - a.profitRate);
    } catch (err: any) {
      throw new Error('Gagal mengambil assets dari Stockity');
    }
  }

  async updateCurrency(userId: string, currencyIso: string) {
    // Invalidate cache agar read berikutnya fresh
    this.sessionCache.delete(userId);
    await this.supabaseService.client
      .from('sessions')
      .upsert({
        user_id: userId,
        currency: currencyIso,
        currency_iso: currencyIso,
        updated_at: this.supabaseService.now(),
      });
    return { currencyIso, message: 'Currency diperbarui' };
  }
}