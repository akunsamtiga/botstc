import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { FirebaseService } from '../firebase/firebase.service';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

const BASE_URL = 'https://api.stockity.id';

// ✅ FIX: User-Agent harus Chrome/146 — diambil dari HAR capture browser asli
//         Chrome/139 ditolak Stockity (header mismatch → 401)
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

// ✅ FIX: Timezone harus Asia/Bangkok — sama dengan yang dikirim browser Stockity
//         Asia/Jakarta menyebabkan header mismatch → request ditolak
const DEFAULT_TIMEZONE = 'Asia/Bangkok';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private jwtService: JwtService,
    private firebaseService: FirebaseService,
  ) {}

  async login(email: string, password: string) {
    this.logger.log(`Login attempt: ${email}`);

    // Ambil deviceId lama jika sudah pernah login
    let deviceId = uuidv4();
    try {
      const existing = await this.firebaseService.db
        .collection('sessions')
        .where('email', '==', email)
        .limit(1)
        .get();
      if (!existing.empty) {
        const data = existing.docs[0].data();
        if (data.deviceId) deviceId = data.deviceId;
      }
    } catch (_) {}

    // Login ke Stockity
    // Response shape dikonfirmasi dari HAR: { data: { authtoken: string, user_id: string } }
    let stockityAuthToken: string;
    let stockityUserId: string;

    try {
      const response = await axios.post(
        `${BASE_URL}/passport/v2/sign_in?locale=id`,
        { email, password },
        {
          headers: {
            // ✅ FIX: Semua header diambil persis dari HAR capture browser asli
            //         Request tanpa header ini akan di-reject Stockity (401/403)
            'cache-control': 'no-cache, no-store, must-revalidate', // ✅ KRITIS — was missing
            'device-id':     deviceId,
            'device-type':   'web',
            'user-timezone': DEFAULT_TIMEZONE,                      // ✅ Bangkok, bukan Jakarta
            'accept':        'application/json, text/plain, */*',   // ✅ exact match browser
            'content-type':  'application/json',
            'User-Agent':    DEFAULT_USER_AGENT,                    // ✅ Chrome/146
            'Origin':        'https://stockity.id',                 // ✅ was missing
            'Referer':       'https://stockity.id/',                // ✅ was missing
            'Cookie':        `device_type=web; device_id=${deviceId}`,
          },
          timeout: 15000,
        },
      );

      // Response confirmed dari HAR: { data: { authtoken: "...", user_id: "..." } }
      const d = response.data?.data ?? {};

      stockityAuthToken = d.authtoken ?? '';
      // user_id bisa string atau number — normalize ke string
      stockityUserId = String(d.user_id ?? d.userId ?? '');

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

      // Log detail response Stockity untuk debugging
      const status = err?.response?.status;
      const body   = err?.response?.data;
      this.logger.error(
        `Stockity login error [HTTP ${status ?? 'no-response'}]: ` +
        `${JSON.stringify(body ?? err.message ?? 'unknown').slice(0, 500)}`,
      );

      const errMsg: string =
        body?.errors?.[0]?.message ||
        body?.errors?.[0]           ||
        body?.message               ||
        body?.error                 ||
        (status === 401 || status === 403 ? 'Email atau password salah' :
         status === 423                   ? 'Akun diblokir'             :
         status >= 500                    ? 'Server Stockity bermasalah, coba lagi nanti' :
         err.message || 'Login gagal');

      throw new UnauthorizedException(errMsg);
    }

    // Simpan session ke Firebase
    await this.firebaseService.db
      .collection('sessions')
      .doc(stockityUserId)
      .set(
        {
          email,
          userId:        stockityUserId,
          stockityToken: stockityAuthToken,
          deviceId,
          deviceType:    'web',
          userAgent:     DEFAULT_USER_AGENT,
          userTimezone:  DEFAULT_TIMEZONE,
          currency:      'IDR',
          currencyIso:   'IDR',
          updatedAt:     this.firebaseService.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

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
    await this.firebaseService.db.collection('sessions').doc(userId).update({
      loggedOutAt: this.firebaseService.FieldValue.serverTimestamp(),
    });
    return { message: 'Logout berhasil' };
  }

  async getMe(userId: string) {
    const docSnap = await this.firebaseService.db.collection('sessions').doc(userId).get();
    if (!docSnap.exists) throw new UnauthorizedException('Session tidak ditemukan');
    const data = docSnap.data();
    return {
      userId:      data.userId,
      email:       data.email,
      deviceId:    data.deviceId,
      currency:    data.currency,
      currencyIso: data.currencyIso,
    };
  }

  async getSession(userId: string) {
    const docSnap = await this.firebaseService.db.collection('sessions').doc(userId).get();
    if (!docSnap.exists) return null;
    return docSnap.data();
  }
}