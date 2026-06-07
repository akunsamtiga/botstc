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
   * mapProfileData — konversi snake_case Stockity → camelCase yang diexpect frontend.
   *
   * Root cause data kosong: Stockity API return snake_case (first_name, email_verified, dst),
   * tapi frontend baca camelCase (firstName, emailVerified, dst) → semua undefined → tampil "—".
   *
   * v2 (platform/private/v2/profile): first_name, last_name, email_verified, phone_verified,
   *                                   docs_verified, registered_at, country, currency, avatar
   * v1 (passport/v1/user_profile):    registration_country_iso, personal_data_locked
   */
  private mapProfileData(v2Data: any, v1Data: any): Record<string, unknown> {
    // Gunakan v2 sebagai sumber utama; v1 sebagai suplemen untuk field yang tidak ada di v2
    const src = v2Data ?? v1Data ?? {};
    const sup = v2Data ? (v1Data ?? {}) : {};

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
      emailVerified:          src.email_verified   ?? false,
      phoneVerified:          src.phone_verified   ?? false,
      docsVerified:           src.docs_verified    ?? false,
      registeredAt:           src.registered_at    ?? null,
      // registration_country_iso hanya ada di v1
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
   * ✅ FIX CURRENCY: getProfile sekarang pakai dua endpoint secara paralel:
   *   1. platform/private/v2/profile  → punya field 'currency' + 'country' (confirmed dari HAR)
   *   2. passport/v1/user_profile     → fallback, tidak punya field currency
   *
   * Dari HAR (akun Colombia/COP):
   *   - passport/v1/user_profile   → TIDAK ada field 'currency', hanya 'country': 'CO'
   *   - platform/private/v2/profile → ADA 'currency': 'COP', 'country': 'CO'
   *
   * Setelah dapat profile, jika currency di session masih 'IDR' tapi profile
   * menunjukkan currency berbeda → auto-update session di Supabase.
   */
  async getProfile(userId: string) {
    const session = await this.getSession(userId);
    const headers = this.buildHeaders(session);

    // ── Fetch kedua endpoint paralel ──────────────────────────────────────
    const [v2Result, v1Result] = await Promise.allSettled([
      curlGet(`${BASE_URL}/platform/private/v2/profile?locale=id`, headers, 10),
      curlGet(`${BASE_URL}/passport/v1/user_profile?locale=id`, headers, 10),
    ]);

    // Ambil data mentah dari masing-masing endpoint (keduanya perlu untuk merge)
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
    // platform/private/v2/profile punya field 'currency' (e.g. 'COP').
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
    // Stockity API return snake_case; frontend baca camelCase → tanpa ini semua field "—"
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

  /**
   * getCurrencyConfig — Backend proxy untuk fetchPlatformCurrencies di frontend.
   *
   * Parsing logic identik dengan fetchPlatformCurrencies (userProfileApi.ts),
   * tapi dijalankan server-side → bebas CORS, frontend tidak perlu hit Stockity langsung.
   *
   * Response Stockity /platform/private/v2/currencies:
   *   data.current                           → ISO code, e.g. "IDR", "COP"
   *   data.list[].unit                       → simbol, e.g. "Rp", "Col$"
   *   data.list[].summs.standard_trade       → preset amounts (dalam cents, ÷100 untuk display)
   *   data.list[].limits.standard_trade.min  → minimum order (cents)
   *   data.list[].limits.standard_trade.max  → maximum order (cents)
   */
  async getCurrencyConfig(userId: string) {
    const session = await this.getSession(userId);
    try {
      const resp = await curlGet(
        `${BASE_URL}/platform/private/v2/currencies?locale=id`,
        { ...this.buildHeaders(session), 'cache-control': 'no-cache' },
        10,
      );
      const data: any = resp.data?.data ?? resp.data;
      if (!data) throw new Error('Response data kosong');

      // Fallback simbol jika API tidak mengembalikan unit (sama dengan ISO_TO_UNIT di userProfileApi.ts)
      const ISO_TO_UNIT: Record<string, string> = {
        IDR: 'Rp',    USD: '$',     EUR: '€',     GBP: '£',     BRL: 'R$',
        COP: 'Col$',  MXN: 'MX$',  ARS: 'AR$',   PEN: 'S/',    CLP: 'CL$',
        NGN: '₦',     KES: 'KSh',  GHS: 'GH₵',   ZAR: 'R',
        INR: '₹',     PKR: '₨',    BDT: '৳',      LKR: 'Rs',
        PHP: '₱',     VND: '₫',    THB: '฿',      MYR: 'RM',    SGD: 'S$',
        TRY: '₺',     UAH: '₴',    KZT: '₸',      UZS: "so'm",
        RUB: '₽',     AMD: '֏',    AZN: '₼',      GEL: '₾',
        EGP: 'E£',    MAD: 'MAD',  TND: 'DT',     DZD: 'DA',
        SAR: '﷼',     AED: 'AED',  KWD: 'KD',     QAR: 'QR',    OMR: 'OMR',
        HKD: 'HK$',   TWD: 'NT$',  CAD: 'CA$',    AUD: 'A$',    NZD: 'NZ$',
        VES: 'Bs.S',  BOB: 'Bs.',  PYG: '₲',      UYU: '$U',    GTQ: 'Q',
        HNL: 'L',     CRC: '₡',    DOP: 'RD$',    CUP: '$',     NIO: 'C$',
      };

      const DEFAULT_QUICK_AMOUNTS = [14_000, 70_000, 140_000, 280_000, 700_000, 1_400_000, 2_800_000];

      const current: string  = data.current ?? 'IDR';
      const item: any        = (data.list ?? []).find((c: any) => c.iso === current);
      if (!item) throw new Error(`Item currency tidak ditemukan untuk: ${current}`);

      const unit         = item.unit || ISO_TO_UNIT[current] || current;
      const rawSumms: number[] = item.summs?.standard_trade ?? [];
      const rawMin: number     = item.limits?.standard_trade?.min ?? 1_400_000;
      const rawMax: number     = item.limits?.standard_trade?.max ?? 7_400_000_000;

      // Stockity menyimpan amounts dalam cents (×100) → bagi 100 untuk display
      const quickAmounts = rawSumms.map((v) => Math.round(v / 100));
      const minAmount    = Math.round(rawMin / 100);
      const maxAmount    = Math.round(rawMax / 100);

      return {
        currencyIso:  current,
        currencyUnit: unit,
        minAmount,
        maxAmount,
        quickAmounts: quickAmounts.length > 0 ? quickAmounts : DEFAULT_QUICK_AMOUNTS,
      };
    } catch (err: any) {
      this.logger.error(`getCurrencyConfig error: ${err.message}`);
      throw new Error('Gagal mengambil currency config dari Stockity');
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