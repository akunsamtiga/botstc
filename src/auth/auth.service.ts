import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { FirebaseService } from '../firebase/firebase.service';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

const BASE_URL = 'https://api.stockity.id';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
const DEFAULT_TIMEZONE = 'Asia/Jakarta';

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
    let stockityData: { authtoken: string; user_id: string };
    try {
      const response = await axios.post(
        `${BASE_URL}/passport/v2/sign_in?locale=id`,
        { email, password },
        {
          headers: {
            'device-id': deviceId,
            'device-type': 'web',
            'user-timezone': DEFAULT_TIMEZONE,
            'User-Agent': DEFAULT_USER_AGENT,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        },
      );

      if (!response.data?.data?.authtoken) {
        throw new UnauthorizedException('Email atau password salah');
      }
      stockityData = response.data.data;
    } catch (err: any) {
      if (err instanceof UnauthorizedException) throw err;
      const errMsg =
        err?.response?.data?.errors?.[0] ||
        err?.response?.data?.message ||
        err.message ||
        'Login gagal';
      this.logger.error(`Stockity login error: ${errMsg}`);
      throw new UnauthorizedException(errMsg);
    }

    const userId = stockityData.user_id;
    const authToken = stockityData.authtoken;

    // Simpan session ke Firebase
    await this.firebaseService.db.collection('sessions').doc(userId).set(
      {
        email,
        userId,
        stockityToken: authToken,
        deviceId,
        deviceType: 'web',
        userAgent: DEFAULT_USER_AGENT,
        userTimezone: DEFAULT_TIMEZONE,
        currency: 'IDR',
        currencyIso: 'IDR',
        updatedAt: this.firebaseService.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    const jwt = this.jwtService.sign({ sub: userId, email });
    this.logger.log(`✅ Login berhasil: ${email} (userId: ${userId})`);

    return {
      accessToken: jwt,
      userId,
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
    const doc = await this.firebaseService.db.collection('sessions').doc(userId).get();
    if (!doc.exists) throw new UnauthorizedException('Session tidak ditemukan');
    const data = doc.data();
    return {
      userId: data.userId,
      email: data.email,
      deviceId: data.deviceId,
      currency: data.currency,
      currencyIso: data.currencyIso,
    };
  }

  async getSession(userId: string) {
    const doc = await this.firebaseService.db.collection('sessions').doc(userId).get();
    if (!doc.exists) return null;
    return doc.data();
  }
}
