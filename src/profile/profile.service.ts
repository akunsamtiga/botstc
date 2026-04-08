import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { curlGet } from '../common/http-utils';

const BASE_URL = 'https://api.stockity.id';

@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);

  constructor(private firebaseService: FirebaseService) {}

  private async getSession(userId: string) {
    const doc = await this.firebaseService.db.collection('sessions').doc(userId).get();
    if (!doc.exists) throw new Error('Session tidak ditemukan');
    return doc.data();
  }

  private buildHeaders(session: any): Record<string, string> {
    return {
      'device-id': session.deviceId,
      'device-type': session.deviceType || 'web',
      'user-timezone': session.userTimezone || 'Asia/Jakarta',
      'authorization-token': session.stockityToken,
      'User-Agent': session.userAgent,
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://stockity.id',
      'Referer': 'https://stockity.id/',
    };
  }

  async getProfile(userId: string) {
    const session = await this.getSession(userId);
    try {
      const resp = await curlGet(
        `${BASE_URL}/passport/v1/user_profile?locale=id`,
        this.buildHeaders(session),
        10, // timeout 10s
      );
      return resp.data?.data || resp.data;
    } catch (err: any) {
      this.logger.error(`getProfile error: ${err.message}`);
      throw new Error('Gagal mengambil profil dari Stockity');
    }
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
      return {
        real_balance: real?.balance ?? 0,
        demo_balance: demo?.balance ?? 0,
        balance: real?.balance ?? 0,
        currency: real?.currency ?? session.currency ?? 'IDR',
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
    await this.firebaseService.db.collection('sessions').doc(userId).update({
      currency: currencyIso,
      currencyIso,
      updatedAt: this.firebaseService.FieldValue.serverTimestamp(),
    });
    return { currencyIso, message: 'Currency diperbarui' };
  }
}
