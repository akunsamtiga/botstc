import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { FirebaseService } from '../firebase/firebase.service';
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

  constructor(
    private jwtService: JwtService,
    private firebaseService: FirebaseService,
  ) {}

  // ── curlPost ─────────────────────────────────────────────────────────────────
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