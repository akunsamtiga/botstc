#!/bin/bash
set -e

# ================================================
#  Stockity Schedule VPS Backend
#  setup.sh — Jalankan di Windows (Git Bash)
#  Fungsi: Generate project files, npm install, build, git init
# ================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error(){ echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
step() { echo -e "\n${CYAN}========================================${NC}"; \
         echo -e "${CYAN}  $1${NC}"; \
         echo -e "${CYAN}========================================${NC}"; }

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════════════╗"
echo "║       Stockity Schedule VPS Backend                  ║"
echo "║       setup.sh — Windows Project Generator           ║"
echo "╚══════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ────────────────────────────────────────────────
# Cek Node.js
# ────────────────────────────────────────────────
step "Cek Node.js"
if ! command -v node &>/dev/null; then
  error "Node.js tidak ditemukan! Install dari https://nodejs.org (minimal v18)"
fi
log "Node.js $(node -v) | npm $(npm -v) ✅"

# ────────────────────────────────────────────────
# STEP 1: Buat struktur folder
# ────────────────────────────────────────────────
step "STEP 1: Membuat struktur folder"

mkdir -p src/auth/dto
mkdir -p src/profile
mkdir -p src/schedule/dto
mkdir -p src/firebase
mkdir -p logs

log "Struktur folder dibuat ✅"

# ────────────────────────────────────────────────
# STEP 2: package.json
# ────────────────────────────────────────────────
step "STEP 2: package.json"
cat > package.json << 'EOF'
{
  "name": "stockity-schedule-vps",
  "version": "1.0.0",
  "description": "Stockity Schedule Mode VPS Backend",
  "private": true,
  "scripts": {
    "build": "nest build",
    "start": "node dist/main",
    "start:dev": "nest start --watch",
    "start:prod": "node dist/main"
  },
  "dependencies": {
    "@nestjs/common": "^10.0.0",
    "@nestjs/core": "^10.0.0",
    "@nestjs/jwt": "^10.2.0",
    "@nestjs/passport": "^10.0.3",
    "@nestjs/platform-express": "^10.0.0",
    "@nestjs/schedule": "^4.0.0",
    "@nestjs/config": "^3.2.0",
    "firebase-admin": "^12.0.0",
    "passport": "^0.7.0",
    "passport-jwt": "^4.0.1",
    "axios": "^1.6.0",
    "ws": "^8.16.0",
    "class-validator": "^0.14.1",
    "class-transformer": "^0.5.1",
    "reflect-metadata": "^0.2.0",
    "rxjs": "^7.8.1",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.0.0",
    "@nestjs/schematics": "^10.0.0",
    "@types/express": "^4.17.21",
    "@types/node": "^20.11.0",
    "@types/passport-jwt": "^4.0.1",
    "@types/uuid": "^9.0.7",
    "@types/ws": "^8.5.10",
    "typescript": "^5.3.0",
    "ts-node": "^10.9.2"
  }
}
EOF
log "package.json ditulis ✅"

# ────────────────────────────────────────────────
# STEP 3: tsconfig & nest-cli
# ────────────────────────────────────────────────
step "STEP 3: tsconfig.json & nest-cli.json"
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "module": "commonjs",
    "declaration": true,
    "removeComments": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "allowSyntheticDefaultImports": true,
    "target": "ES2021",
    "sourceMap": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "incremental": true,
    "skipLibCheck": true,
    "strictNullChecks": false,
    "noImplicitAny": false,
    "strictBindCallApply": false,
    "forceConsistentCasingInFileNames": false,
    "noFallthroughCasesInSwitch": false
  }
}
EOF

cat > nest-cli.json << 'EOF'
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true
  }
}
EOF
log "Config files ditulis ✅"

# ────────────────────────────────────────────────
# STEP 4: .gitignore
# ────────────────────────────────────────────────
step "STEP 4: .gitignore"
cat > .gitignore << 'EOF'
# Dependencies
node_modules/

# Build output
dist/

# Environment - JANGAN PERNAH PUSH KE GIT!
.env
firebase-service-account.json

# Logs
logs/
*.log
npm-debug.log*

# OS
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/
*.swp
*.swo

# TypeScript
*.tsbuildinfo
EOF
log ".gitignore ditulis ✅"

# ────────────────────────────────────────────────
# STEP 5: PM2 ecosystem config
# ────────────────────────────────────────────────
step "STEP 5: ecosystem.config.js"
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [
    {
      name: 'stockity-schedule-vps',
      script: 'dist/main.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
};
EOF
log "ecosystem.config.js ditulis ✅"

# ────────────────────────────────────────────────
# STEP 6: .env.example (template, BUKAN .env asli)
# ────────────────────────────────────────────────
step "STEP 6: .env.example"
cat > .env.example << 'EOF'
# ================================================
# Stockity Schedule VPS Backend — Environment Config
# COPY FILE INI KE .env DAN ISI NILAINYA
# JANGAN PUSH .env KE GIT!
# ================================================

PORT=3000
CORS_ORIGIN=*

# JWT — ganti dengan string random panjang minimal 64 karakter
JWT_SECRET=GANTI_DENGAN_RANDOM_STRING_SANGAT_PANJANG
JWT_EXPIRES_IN=7d

# Firebase — gunakan salah satu opsi:

# OPSI 1 (Recommended): path ke file service account JSON
FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json

# OPSI 2: env vars langsung (untuk hosting yang tidak support file)
# FIREBASE_PROJECT_ID=your-project-id
# FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
# FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_KEY\n-----END PRIVATE KEY-----\n"
EOF
log ".env.example ditulis ✅"

# ────────────────────────────────────────────────
# STEP 7: Firebase Module
# ────────────────────────────────────────────────
step "STEP 7: Firebase Module"
cat > src/firebase/firebase.service.ts << 'EOF'
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private _db: admin.firestore.Firestore;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    if (admin.apps.length === 0) {
      const serviceAccountPath = this.configService.get<string>('FIREBASE_SERVICE_ACCOUNT_PATH');
      const projectId = this.configService.get<string>('FIREBASE_PROJECT_ID');

      if (serviceAccountPath) {
        // Resolve path relatif dari project root
        const path = require('path');
        const resolvedPath = path.resolve(process.cwd(), serviceAccountPath);
        const serviceAccount = require(resolvedPath);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          projectId: serviceAccount.project_id || projectId,
        });
      } else {
        const privateKey = this.configService.get<string>('FIREBASE_PRIVATE_KEY');
        const clientEmail = this.configService.get<string>('FIREBASE_CLIENT_EMAIL');
        if (!privateKey || !clientEmail || !projectId) {
          throw new Error(
            'Firebase config tidak lengkap. Set FIREBASE_SERVICE_ACCOUNT_PATH atau ' +
            'FIREBASE_PRIVATE_KEY + FIREBASE_CLIENT_EMAIL + FIREBASE_PROJECT_ID di .env'
          );
        }
        admin.initializeApp({
          credential: admin.credential.cert({
            projectId,
            privateKey: privateKey.replace(/\\n/g, '\n'),
            clientEmail,
          }),
        });
      }
    }
    this._db = admin.firestore();
    this.logger.log('✅ Firebase Firestore terhubung');
  }

  get db(): admin.firestore.Firestore {
    return this._db;
  }

  get FieldValue() {
    return admin.firestore.FieldValue;
  }

  get Timestamp() {
    return admin.firestore.Timestamp;
  }
}
EOF

cat > src/firebase/firebase.module.ts << 'EOF'
import { Global, Module } from '@nestjs/common';
import { FirebaseService } from './firebase.service';

@Global()
@Module({
  providers: [FirebaseService],
  exports: [FirebaseService],
})
export class FirebaseModule {}
EOF
log "Firebase module ditulis ✅"

# ────────────────────────────────────────────────
# STEP 8: Auth Module
# ────────────────────────────────────────────────
step "STEP 8: Auth Module"

cat > src/auth/dto/login.dto.ts << 'EOF'
import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail({}, { message: 'Format email tidak valid' })
  email: string;

  @IsString()
  @MinLength(6, { message: 'Password minimal 6 karakter' })
  password: string;
}
EOF

cat > src/auth/jwt.strategy.ts << 'EOF'
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { FirebaseService } from '../firebase/firebase.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private firebaseService: FirebaseService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'),
    });
  }

  async validate(payload: { sub: string; email: string }) {
    const doc = await this.firebaseService.db
      .collection('sessions')
      .doc(payload.sub)
      .get();
    if (!doc.exists) throw new UnauthorizedException('Session tidak ditemukan, silakan login ulang');
    return { userId: payload.sub, email: payload.email };
  }
}
EOF

cat > src/auth/jwt-auth.guard.ts << 'EOF'
import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
EOF

cat > src/auth/auth.service.ts << 'EOF'
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
EOF

cat > src/auth/auth.controller.ts << 'EOF'
import {
  Body, Controller, Get, Post,
  Request, UseGuards, HttpCode,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(200)
  logout(@Request() req) {
    return this.authService.logout(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  getMe(@Request() req) {
    return this.authService.getMe(req.user.userId);
  }
}
EOF

cat > src/auth/auth.module.ts << 'EOF'
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN', '7d') },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
EOF
log "Auth module ditulis ✅"

# ────────────────────────────────────────────────
# STEP 9: Profile Module
# ────────────────────────────────────────────────
step "STEP 9: Profile Module"

cat > src/profile/profile.service.ts << 'EOF'
import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import axios from 'axios';

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

  private buildHeaders(session: any) {
    return {
      'device-id': session.deviceId,
      'device-type': session.deviceType || 'web',
      'user-timezone': session.userTimezone || 'Asia/Jakarta',
      'authorization-token': session.stockityToken,
      'User-Agent': session.userAgent,
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://stockity.id',
      Referer: 'https://stockity.id/',
    };
  }

  async getProfile(userId: string) {
    const session = await this.getSession(userId);
    try {
      const resp = await axios.get(`${BASE_URL}/passport/v1/user_profile?locale=id`, {
        headers: this.buildHeaders(session),
        timeout: 10000,
      });
      return resp.data?.data || resp.data;
    } catch (err: any) {
      this.logger.error(`getProfile error: ${err.message}`);
      throw new Error('Gagal mengambil profil dari Stockity');
    }
  }

  async getBalance(userId: string) {
    const session = await this.getSession(userId);
    try {
      const resp = await axios.get(`${BASE_URL}/bank/v1/read?locale=id`, {
        headers: { ...this.buildHeaders(session), 'Cache-Control': 'no-cache' },
        timeout: 10000,
      });
      const data: any[] = resp.data?.data || [];
      const real = data.find((d) => d.account_type === 'real');
      const demo = data.find((d) => d.account_type === 'demo');
      return {
        realBalance: real?.balance ?? 0,
        demoBalance: demo?.balance ?? 0,
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
      const resp = await axios.get(`${BASE_URL}/platform/private/v2/currencies?locale=id`, {
        headers: { ...this.buildHeaders(session), 'cache-control': 'no-cache' },
        timeout: 10000,
      });
      return resp.data?.data || resp.data;
    } catch (err: any) {
      throw new Error('Gagal mengambil currencies dari Stockity');
    }
  }

  async getAssets(userId: string) {
    const session = await this.getSession(userId);
    try {
      const resp = await axios.get(`${BASE_URL}/bo-assets/v6/assets?locale=id`, {
        headers: this.buildHeaders(session),
        timeout: 15000,
      });
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
EOF

cat > src/profile/profile.controller.ts << 'EOF'
import { Controller, Get, Put, Body, Request, UseGuards } from '@nestjs/common';
import { ProfileService } from './profile.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('profile')
export class ProfileController {
  constructor(private profileService: ProfileService) {}

  @Get()
  getProfile(@Request() req) {
    return this.profileService.getProfile(req.user.userId);
  }

  @Get('balance')
  getBalance(@Request() req) {
    return this.profileService.getBalance(req.user.userId);
  }

  @Get('currencies')
  getCurrencies(@Request() req) {
    return this.profileService.getCurrencies(req.user.userId);
  }

  @Get('assets')
  getAssets(@Request() req) {
    return this.profileService.getAssets(req.user.userId);
  }

  @Put('currency')
  updateCurrency(@Request() req, @Body('currencyIso') currencyIso: string) {
    return this.profileService.updateCurrency(req.user.userId, currencyIso);
  }
}
EOF

cat > src/profile/profile.module.ts << 'EOF'
import { Module } from '@nestjs/common';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';

@Module({
  controllers: [ProfileController],
  providers: [ProfileService],
})
export class ProfileModule {}
EOF
log "Profile module ditulis ✅"

# ────────────────────────────────────────────────
# STEP 10: Schedule Types
# ────────────────────────────────────────────────
step "STEP 10: Schedule Types"

cat > src/schedule/types.ts << 'EOF'
export type BotState = 'STOPPED' | 'RUNNING' | 'PAUSED';
export type MultiplierType = 'FIXED' | 'PERCENTAGE';
export type TrendType = 'call' | 'put';

export interface MartingaleSettings {
  isEnabled: boolean;
  maxSteps: number;
  baseAmount: number;
  multiplierValue: number;
  multiplierType: MultiplierType;
  isAlwaysSignal: boolean;
}

export interface AssetConfig {
  ric: string;
  name: string;
}

export interface ScheduleConfig {
  asset: AssetConfig;
  martingale: MartingaleSettings;
  isDemoAccount: boolean;
  currency: string;
  currencyIso: string;
  duration: number;
}

export interface ScheduledOrderMartingaleState {
  isActive: boolean;
  currentStep: number;
  maxSteps: number;
  isCompleted: boolean;
  finalResult?: string;
  totalLoss: number;
  totalRecovered: number;
  failureReason?: string;
  lastUpdateTime?: number;
}

export interface ScheduledOrder {
  id: string;
  time: string;
  trend: TrendType;
  timeInMillis: number;
  isExecuted: boolean;
  isSkipped: boolean;
  skipReason?: string;
  martingaleState: ScheduledOrderMartingaleState;
  result?: string;
  activeDealId?: string;
}

export interface AlwaysSignalLossState {
  hasOutstandingLoss: boolean;
  currentMartingaleStep: number;
  originalOrderId: string;
  totalLoss: number;
  currentTrend: TrendType;
}

export interface TradeOrderData {
  amount: number;
  createdAt: number;
  dealType: string;
  expireAt: number;
  iso: string;
  optionType: string;
  ric: string;
  trend: TrendType;
}

export interface ExecutionLog {
  id: string;
  orderId: string;
  time: string;
  trend: TrendType;
  amount: number;
  martingaleStep: number;
  dealId?: string;
  result?: string;
  executedAt: number;
  note?: string;
}
EOF
log "Types ditulis ✅"

# ────────────────────────────────────────────────
# STEP 11: WebSocket Client
# ────────────────────────────────────────────────
step "STEP 11: WebSocket Client"

cat > src/schedule/websocket-client.ts << 'EOF'
import * as WebSocket from 'ws';
import { Logger } from '@nestjs/common';
import { TradeOrderData } from './types';

export interface DealResultPayload {
  id: string;
  status?: string;
  result?: string;
  trend?: string;
  amount?: number;
  win?: number;
  [key: string]: any;
}

export class StockityWebSocketClient {
  private readonly logger = new Logger('StockityWS');
  private ws: WebSocket | null = null;
  private refCounter = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT = 10;
  private isDestroyed = false;

  private pendingTrades: Map<
    string,
    { resolve: (dealId: string | null) => void; timer: NodeJS.Timeout }
  > = new Map();

  private onDealResultCb?: (payload: DealResultPayload) => void;
  private onStatusChangeCb?: (connected: boolean, reason?: string) => void;

  constructor(
    private readonly userId: string,
    private readonly authToken: string,
    private readonly deviceId: string,
    private readonly deviceType: string,
    private readonly userAgent: string,
  ) {}

  setOnDealResult(cb: (payload: DealResultPayload) => void) {
    this.onDealResultCb = cb;
  }

  setOnStatusChange(cb: (connected: boolean, reason?: string) => void) {
    this.onStatusChangeCb = cb;
  }

  private getRef(): string {
    return String(++this.refCounter);
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isDestroyed) return reject(new Error('Client sudah di-destroy'));

      try {
        this.ws = new WebSocket('wss://ws.stockity.id/?v=2&vsn=2.0.0', {
          headers: {
            'User-Agent': this.userAgent,
            'Sec-WebSocket-Protocol': 'phoenix',
            Origin: 'https://stockity.id',
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
          },
          handshakeTimeout: 15000,
        });

        const connectTimeout = setTimeout(() => {
          reject(new Error('WebSocket connection timeout'));
          this.ws?.terminate();
        }, 20000);

        this.ws.on('open', () => {
          clearTimeout(connectTimeout);
          this.reconnectAttempts = 0;
          this.logger.log(`[${this.userId}] ✅ WebSocket connected`);
          this.joinChannels();
          this.startHeartbeat();
          this.onStatusChangeCb?.(true);
          resolve();
        });

        this.ws.on('message', (raw: Buffer | string) => {
          this.handleMessage(raw.toString());
        });

        this.ws.on('error', (err) => {
          this.logger.error(`[${this.userId}] WS error: ${err.message}`);
          this.onStatusChangeCb?.(false, err.message);
          clearTimeout(connectTimeout);
          reject(err);
        });

        this.ws.on('close', (code, reason) => {
          this.logger.warn(`[${this.userId}] WS closed: ${code} ${reason?.toString()}`);
          this.stopHeartbeat();
          this.onStatusChangeCb?.(false, `Closed: ${code}`);
          if (!this.isDestroyed) this.scheduleReconnect();
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private joinChannels() {
    this.sendRaw(['1', '1', `user:${this.userId}`, 'phx_join', { token: this.authToken }]);
    this.sendRaw(['2', '2', 'bo', 'phx_join', { token: this.authToken }]);
  }

  private sendRaw(msg: any[]): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendRaw([null, this.getRef(), 'phoenix', 'heartbeat', {}]);
    }, 30000);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.isDestroyed) return;
    if (this.reconnectAttempts >= this.MAX_RECONNECT) {
      this.logger.error(`[${this.userId}] Max reconnect attempts reached`);
      return;
    }
    const delay = Math.min(2000 * Math.pow(1.5, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    this.logger.log(`[${this.userId}] Reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (err: any) {
        this.logger.error(`[${this.userId}] Reconnect failed: ${err.message}`);
      }
    }, delay);
  }

  private handleMessage(raw: string) {
    try {
      const msg = JSON.parse(raw);
      if (!Array.isArray(msg) || msg.length < 5) return;
      const [, ref, topic, event, payload] = msg;

      // Deal result dari user channel
      if (topic === `user:${this.userId}` && event === 'deal' && payload) {
        this.logger.debug(`[${this.userId}] Deal result: ${payload.id} → ${payload.status || payload.result}`);
        this.onDealResultCb?.(payload);
      }

      // Reply sukses placement trade
      if (event === 'phx_reply' && payload?.status === 'ok' && ref) {
        const dealId = payload?.response?.id;
        if (dealId) {
          const pending = this.pendingTrades.get(ref);
          if (pending) {
            clearTimeout(pending.timer);
            pending.resolve(dealId);
            this.pendingTrades.delete(ref);
            this.logger.log(`[${this.userId}] Trade placed: dealId=${dealId}`);
          }
        }
      }

      // Error reply
      if (event === 'phx_reply' && payload?.status === 'error' && ref) {
        const pending = this.pendingTrades.get(ref);
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve(null);
          this.pendingTrades.delete(ref);
          this.logger.warn(`[${this.userId}] Trade error: ${JSON.stringify(payload.response)}`);
        }
      }
    } catch {
      // ignore non-JSON
    }
  }

  async placeTrade(order: TradeOrderData): Promise<string | null> {
    const ref = this.getRef();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingTrades.delete(ref);
        this.logger.warn(`[${this.userId}] Trade timeout ref=${ref}`);
        resolve(null);
      }, 8000);

      this.pendingTrades.set(ref, { resolve, timer });

      const sent = this.sendRaw([
        null, ref, 'bo', 'create',
        {
          amount: order.amount,
          created_at: order.createdAt,
          deal_type: order.dealType,
          expire_at: order.expireAt,
          iso: order.iso,
          option_type: order.optionType,
          ric: order.ric,
          trend: order.trend,
        },
      ]);

      if (!sent) {
        clearTimeout(timer);
        this.pendingTrades.delete(ref);
        this.logger.error(`[${this.userId}] WS tidak open, tidak bisa place trade`);
        resolve(null);
      }
    });
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  disconnect() {
    this.isDestroyed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, pending] of this.pendingTrades.entries()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.pendingTrades.clear();
    this.ws?.close();
    this.ws = null;
    this.logger.log(`[${this.userId}] WebSocket disconnected`);
  }
}
EOF
log "WebSocket client ditulis ✅"

# ────────────────────────────────────────────────
# STEP 12: Schedule Executor
# ────────────────────────────────────────────────
step "STEP 12: Schedule Executor"

cat > src/schedule/schedule-executor.ts << 'EOF'
import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { StockityWebSocketClient, DealResultPayload } from './websocket-client';
import {
  ScheduledOrder, ScheduleConfig, BotState,
  AlwaysSignalLossState, TradeOrderData,
  ExecutionLog, TrendType,
} from './types';

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
const EXECUTION_ADVANCE_MS = 2000;
const PRECISION_CHECK_MS = 100;
const EXECUTION_WINDOW_MS = 4900;
const MARTINGALE_MAX_DURATION_MS = 600000;
const STEP_STUCK_THRESHOLD_MS = 150000;
const MIN_PREP_TIME_MS = 10000;

export interface ExecutorCallbacks {
  onOrdersUpdate: (orders: ScheduledOrder[]) => void;
  onLog: (log: ExecutionLog) => void;
  onAllCompleted: () => void;
  onStatusChange: (status: string) => void;
}

export class ScheduleExecutor {
  private readonly logger = new Logger('ScheduleExecutor');
  private botState: BotState = 'STOPPED';
  private orders: ScheduledOrder[];
  private config: ScheduleConfig;
  private activeMartingaleOrderId?: string;
  private martingaleStartTime?: number;
  private alwaysSignalLossState?: AlwaysSignalLossState;
  private monitoringTimer?: NodeJS.Timeout;
  private completionTimer?: NodeJS.Timeout;
  private lastCompletionCheck = 0;

  constructor(
    private readonly userId: string,
    private readonly wsClient: StockityWebSocketClient,
    private readonly callbacks: ExecutorCallbacks,
    initialOrders: ScheduledOrder[],
    initialConfig: ScheduleConfig,
  ) {
    this.orders = [...initialOrders];
    this.config = { ...initialConfig };
    this.wsClient.setOnDealResult((p) => this.handleDealResult(p));
  }

  // ── Public Control ──────────────────────────

  start() {
    if (this.botState === 'RUNNING') return;
    this.botState = 'RUNNING';
    this.alwaysSignalLossState = undefined;
    this.logger.log(`[${this.userId}] 🚀 Executor started | orders: ${this.orders.filter(o => !o.isExecuted && !o.isSkipped).length}`);
    this.startMonitoringLoop();
    this.startCompletionCheck();
  }

  pause() {
    if (this.botState !== 'RUNNING') return;
    this.botState = 'PAUSED';
    this.stopMonitoringLoop();
    this.logger.log(`[${this.userId}] ⏸️ Paused`);
  }

  resume() {
    if (this.botState !== 'PAUSED') return;
    this.botState = 'RUNNING';
    this.startMonitoringLoop();
    this.logger.log(`[${this.userId}] ▶️ Resumed`);
  }

  stop() {
    this.botState = 'STOPPED';
    this.stopMonitoringLoop();
    this.stopCompletionCheck();
    if (this.activeMartingaleOrderId) {
      const idx = this.orders.findIndex(o => o.id === this.activeMartingaleOrderId);
      if (idx !== -1) {
        this.orders[idx] = {
          ...this.orders[idx],
          martingaleState: {
            ...this.orders[idx].martingaleState,
            isActive: false, isCompleted: true,
            finalResult: 'FAILED', failureReason: 'Bot stopped',
          },
        };
      }
    }
    this.activeMartingaleOrderId = undefined;
    this.martingaleStartTime = undefined;
    this.alwaysSignalLossState = undefined;
    this.callbacks.onOrdersUpdate(this.orders);
    this.logger.log(`[${this.userId}] ⏹️ Stopped`);
  }

  getBotState(): BotState { return this.botState; }
  getOrders(): ScheduledOrder[] { return [...this.orders]; }
  getActiveMartingaleOrderId() { return this.activeMartingaleOrderId; }
  getAlwaysSignalLossState() { return this.alwaysSignalLossState; }

  updateConfig(config: ScheduleConfig) { this.config = { ...config }; }

  addOrders(newOrders: ScheduledOrder[]): ScheduledOrder[] {
    const now = Date.now();
    const keys = new Set(this.orders.map(o => `${o.time}_${o.trend}`));
    const valid = newOrders.filter(o => {
      const t = o.timeInMillis - EXECUTION_ADVANCE_MS - now;
      return t >= MIN_PREP_TIME_MS && !keys.has(`${o.time}_${o.trend}`);
    });
    this.orders.push(...valid);
    this.orders.sort((a, b) => a.timeInMillis - b.timeInMillis);
    this.callbacks.onOrdersUpdate(this.orders);
    return valid;
  }

  removeOrder(orderId: string) {
    const before = this.orders.length;
    this.orders = this.orders.filter(o => o.id !== orderId);
    if (this.activeMartingaleOrderId === orderId) this.activeMartingaleOrderId = undefined;
    if (this.orders.length !== before) this.callbacks.onOrdersUpdate(this.orders);
    if (this.orders.length === 0 && this.botState === 'RUNNING') {
      this.stop();
      this.callbacks.onAllCompleted();
    }
  }

  clearOrders() {
    this.orders = [];
    this.activeMartingaleOrderId = undefined;
    this.alwaysSignalLossState = undefined;
    if (this.botState === 'RUNNING') this.stop();
    this.callbacks.onOrdersUpdate([]);
    this.callbacks.onAllCompleted();
  }

  // ── Monitoring Loop ──────────────────────────

  private startMonitoringLoop() {
    this.stopMonitoringLoop();
    this.monitoringTimer = setInterval(() => this.tick(), PRECISION_CHECK_MS);
  }

  private stopMonitoringLoop() {
    if (this.monitoringTimer) { clearInterval(this.monitoringTimer); this.monitoringTimer = undefined; }
  }

  private tick() {
    if (this.botState !== 'RUNNING') return;
    const now = Date.now();
    let changed = false;

    this.checkStuckMartingale(now);

    for (let i = 0; i < this.orders.length; i++) {
      const order = this.orders[i];
      if (order.isExecuted || order.isSkipped) continue;

      const target = order.timeInMillis - EXECUTION_ADVANCE_MS;
      const timeUntil = target - now;

      // Expired
      if (timeUntil < -EXECUTION_WINDOW_MS) {
        this.orders[i] = { ...order, isSkipped: true, skipReason: `Expired ${Math.abs(timeUntil)}ms ago` };
        changed = true;
        this.logger.warn(`[${this.userId}] ⏭️ Skipped expired: ${order.time} ${order.trend}`);
        continue;
      }

      // Execute window
      if (timeUntil <= 0 && timeUntil >= -EXECUTION_WINDOW_MS) {
        if (this.activeMartingaleOrderId && this.activeMartingaleOrderId !== order.id) {
          this.orders[i] = { ...order, isSkipped: true, skipReason: 'Martingale aktif dari order lain' };
          changed = true;
          continue;
        }
        this.orders[i] = { ...order, isExecuted: true };
        changed = true;
        this.executeOrder(this.orders[i]);
      }
    }

    // Hapus order kemarin
    const startToday = this.getStartOfJakartaDay();
    const before = this.orders.length;
    this.orders = this.orders.filter(o => !((o.isExecuted || o.isSkipped) && o.timeInMillis < startToday));
    if (this.orders.length !== before) changed = true;

    if (changed) this.callbacks.onOrdersUpdate(this.orders);
  }

  // ── Trade Execution ──────────────────────────

  private async executeOrder(order: ScheduledOrder) {
    const isAlways = this.config.martingale.isEnabled && this.config.martingale.isAlwaysSignal;
    const lossState = this.alwaysSignalLossState;
    const hasLoss = isAlways && lossState?.hasOutstandingLoss;
    const step = hasLoss ? lossState.currentMartingaleStep : 0;
    const amount = this.calcAmount(step);

    this.logger.log(`[${this.userId}] 🚀 Execute ${order.time} ${order.trend.toUpperCase()} amount=${amount} step=${step}`);

    const tradeData = this.buildTradeOrder(order.trend, amount);
    const dealId = await this.wsClient.placeTrade(tradeData);

    if (dealId) {
      const idx = this.orders.findIndex(o => o.id === order.id);
      if (idx !== -1) {
        this.orders[idx] = { ...this.orders[idx], activeDealId: dealId };
        this.callbacks.onOrdersUpdate(this.orders);
      }
    } else {
      this.logger.error(`[${this.userId}] ❌ Trade failed for ${order.id}`);
      if (isAlways) this.advanceAlwaysSignalLoss(order, step, amount);
    }

    const log: ExecutionLog = {
      id: uuidv4(), orderId: order.id, time: order.time,
      trend: order.trend, amount, martingaleStep: step,
      dealId: dealId ?? undefined,
      result: dealId ? undefined : 'FAILED',
      executedAt: Date.now(),
    };
    this.callbacks.onLog(log);
  }

  // ── Deal Result ──────────────────────────────

  private handleDealResult(payload: DealResultPayload) {
    const dealId = payload.id;
    const s = (payload.status || payload.result || '').toLowerCase();
    const isWin = s === 'won' || s === 'win';
    const isDraw = s === 'stand' || s === 'draw' || s === 'tie';

    const orderIdx = this.orders.findIndex(o => o.activeDealId === dealId);

    if (orderIdx === -1) {
      // Mungkin deal martingale
      if (this.activeMartingaleOrderId) {
        const mIdx = this.orders.findIndex(o => o.id === this.activeMartingaleOrderId);
        if (mIdx !== -1) this.processMartingaleResult(mIdx, isWin, isDraw, dealId);
      }
      return;
    }

    const order = this.orders[orderIdx];
    const isAlways = this.config.martingale.isEnabled && this.config.martingale.isAlwaysSignal;
    const isRegular = this.config.martingale.isEnabled && !isAlways && this.config.martingale.maxSteps > 1;

    if (isDraw) { this.completeOrder(orderIdx, 'DRAW', dealId); return; }

    if (isWin) {
      if (isAlways) this.alwaysSignalLossState = undefined;
      if (this.activeMartingaleOrderId === order.id) {
        this.activeMartingaleOrderId = undefined;
        this.martingaleStartTime = undefined;
      }
      this.completeOrder(orderIdx, 'WIN', dealId);
    } else {
      if (isAlways) {
        const step = this.alwaysSignalLossState?.currentMartingaleStep ?? 0;
        this.advanceAlwaysSignalLoss(order, step, this.calcAmount(step));
        this.completeOrder(orderIdx, 'LOSE', dealId);
      } else if (isRegular) {
        this.startMartingale(order, orderIdx);
      } else {
        this.completeOrder(orderIdx, 'LOSE', dealId);
      }
    }
  }

  private processMartingaleResult(orderIdx: number, isWin: boolean, isDraw: boolean, dealId: string) {
    const order = this.orders[orderIdx];
    const step = order.martingaleState.currentStep;
    const max = this.config.martingale.maxSteps;

    if (isDraw) {
      this.activeMartingaleOrderId = undefined;
      this.martingaleStartTime = undefined;
      this.completeOrder(orderIdx, 'DRAW', dealId);
      return;
    }
    if (isWin) {
      this.activeMartingaleOrderId = undefined;
      this.martingaleStartTime = undefined;
      this.completeOrder(orderIdx, 'WIN', dealId);
    } else {
      if (step >= max) {
        this.activeMartingaleOrderId = undefined;
        this.martingaleStartTime = undefined;
        this.completeOrder(orderIdx, 'LOSE', dealId);
      } else {
        const next = step + 1;
        this.updateMartingaleStep(orderIdx, next);
        this.placeMartingaleTrade(order, next, this.calcAmount(next));
        this.logger.log(`[${this.userId}] 🔄 Martingale step ${next}/${max}`);
      }
    }
  }

  private async placeMartingaleTrade(order: ScheduledOrder, step: number, amount: number) {
    const dealId = await this.wsClient.placeTrade(this.buildTradeOrder(order.trend, amount));
    if (dealId) {
      const idx = this.orders.findIndex(o => o.id === order.id);
      if (idx !== -1) { this.orders[idx] = { ...this.orders[idx], activeDealId: dealId }; this.callbacks.onOrdersUpdate(this.orders); }
    }
    this.callbacks.onLog({
      id: uuidv4(), orderId: order.id, time: order.time, trend: order.trend,
      amount, martingaleStep: step, dealId: dealId ?? undefined,
      result: dealId ? undefined : 'FAILED', executedAt: Date.now(),
      note: `Martingale step ${step}`,
    });
  }

  private startMartingale(order: ScheduledOrder, orderIdx: number) {
    this.activeMartingaleOrderId = order.id;
    this.martingaleStartTime = Date.now();
    const step = 1;
    this.updateMartingaleStep(orderIdx, step);
    this.placeMartingaleTrade(order, step, this.calcAmount(step));
  }

  private updateMartingaleStep(orderIdx: number, step: number) {
    this.orders[orderIdx] = {
      ...this.orders[orderIdx],
      martingaleState: {
        ...this.orders[orderIdx].martingaleState,
        isActive: true, currentStep: step,
        lastUpdateTime: Date.now(), isCompleted: false,
      },
    };
    this.callbacks.onOrdersUpdate(this.orders);
  }

  private advanceAlwaysSignalLoss(order: ScheduledOrder, step: number, lossAmount: number) {
    const nextStep = step + 1;
    if (nextStep > this.config.martingale.maxSteps) {
      this.alwaysSignalLossState = undefined;
      return;
    }
    const prev = this.alwaysSignalLossState?.totalLoss ?? 0;
    this.alwaysSignalLossState = {
      hasOutstandingLoss: true,
      currentMartingaleStep: nextStep,
      originalOrderId: order.id,
      totalLoss: prev + lossAmount,
      currentTrend: order.trend,
    };
    this.logger.log(`[${this.userId}] 📊 AlwaysSignal step=${nextStep}/${this.config.martingale.maxSteps}`);
  }

  private completeOrder(orderIdx: number, result: 'WIN' | 'LOSE' | 'DRAW', dealId?: string) {
    const order = this.orders[orderIdx];
    const finalResult = result === 'WIN' ? 'WIN' : result === 'DRAW' ? 'DRAW' : 'LOSS';
    this.orders[orderIdx] = {
      ...order, result,
      activeDealId: dealId,
      martingaleState: {
        ...order.martingaleState,
        isActive: false, isCompleted: true,
        finalResult, lastUpdateTime: Date.now(),
      },
    };
    this.callbacks.onOrdersUpdate(this.orders);
    this.logger.log(`[${this.userId}] ✅ ${order.time} ${order.trend} → ${result}`);
  }

  // ── Stuck Martingale Cleanup ──────────────────

  private checkStuckMartingale(now: number) {
    if (!this.activeMartingaleOrderId) return;
    const idx = this.orders.findIndex(o => o.id === this.activeMartingaleOrderId);
    if (idx === -1) { this.activeMartingaleOrderId = undefined; this.martingaleStartTime = undefined; return; }
    const o = this.orders[idx];
    const dur = this.martingaleStartTime ? now - this.martingaleStartTime : 0;
    const stepDur = o.martingaleState.lastUpdateTime ? now - o.martingaleState.lastUpdateTime : 0;
    if (dur > MARTINGALE_MAX_DURATION_MS || stepDur > STEP_STUCK_THRESHOLD_MS || o.martingaleState.isCompleted) {
      this.logger.warn(`[${this.userId}] ⚠️ Force-complete stuck martingale`);
      this.orders[idx] = { ...o, martingaleState: { ...o.martingaleState, isActive: false, isCompleted: true, finalResult: 'FAILED', failureReason: 'Timeout/stuck' } };
      this.activeMartingaleOrderId = undefined;
      this.martingaleStartTime = undefined;
      this.callbacks.onOrdersUpdate(this.orders);
    }
  }

  // ── Completion Check ──────────────────────────

  private startCompletionCheck() {
    this.stopCompletionCheck();
    this.completionTimer = setInterval(() => this.checkCompletion(), 5000);
  }

  private stopCompletionCheck() {
    if (this.completionTimer) { clearInterval(this.completionTimer); this.completionTimer = undefined; }
  }

  private checkCompletion() {
    if (this.botState !== 'RUNNING') return;
    const now = Date.now();
    if (now - this.lastCompletionCheck < 5000) return;
    this.lastCompletionCheck = now;
    const hasPending = this.orders.some(o => !o.isExecuted && !o.isSkipped);
    const hasIncompleteMart = this.orders.some(o => o.martingaleState.isActive && !o.martingaleState.isCompleted);
    if (!hasPending && !this.activeMartingaleOrderId && !hasIncompleteMart && this.orders.length > 0) {
      this.logger.log(`[${this.userId}] ✅ All schedules completed`);
      setTimeout(() => { this.stop(); this.callbacks.onAllCompleted(); }, 3000);
    }
  }

  // ── Trade Builder ─────────────────────────────

  private buildTradeOrder(trend: TrendType, amount: number): TradeOrderData {
    const nowMs = Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    const secondsInMinute = nowSeconds % 60;
    const minuteBoundary = nowSeconds + (60 - secondsInMinute);
    const dur = minuteBoundary - nowSeconds;
    const expireAt = (dur < 55 || dur > 120) ? nowSeconds + 60 : minuteBoundary;
    return {
      amount, createdAt: nowMs,
      dealType: this.config.isDemoAccount ? 'demo' : 'real',
      expireAt, iso: this.config.currencyIso,
      optionType: 'turbo', ric: this.config.asset.ric, trend,
    };
  }

  private calcAmount(step: number): number {
    const m = this.config.martingale;
    if (!m.isEnabled || step === 0) return m.baseAmount;
    if (m.multiplierType === 'FIXED') return Math.floor(m.baseAmount * Math.pow(m.multiplierValue, step));
    const mult = 1 + m.multiplierValue / 100;
    return Math.floor(m.baseAmount * Math.pow(mult, step));
  }

  private getStartOfJakartaDay(): number {
    const d = new Date(Date.now() + JAKARTA_OFFSET_MS);
    d.setHours(0, 0, 0, 0);
    return d.getTime() - JAKARTA_OFFSET_MS;
  }

  getStatus(): object {
    const pending = this.orders.filter(o => !o.isExecuted && !o.isSkipped);
    const next = [...pending].sort((a, b) => a.timeInMillis - b.timeInMillis)[0];
    const now = Date.now();
    return {
      botState: this.botState,
      totalOrders: this.orders.length,
      pendingOrders: pending.length,
      executedOrders: this.orders.filter(o => o.isExecuted).length,
      skippedOrders: this.orders.filter(o => o.isSkipped).length,
      activeMartingaleOrderId: this.activeMartingaleOrderId ?? null,
      alwaysSignalActive: !!this.alwaysSignalLossState?.hasOutstandingLoss,
      alwaysSignalStep: this.alwaysSignalLossState?.currentMartingaleStep ?? 0,
      nextOrderTime: next?.time ?? null,
      nextOrderInSeconds: next ? Math.max(0, Math.floor((next.timeInMillis - EXECUTION_ADVANCE_MS - now) / 1000)) : null,
      wsConnected: this.wsClient.isConnected(),
    };
  }
}
EOF
log "Schedule executor ditulis ✅"

# ────────────────────────────────────────────────
# STEP 13: DTOs
# ────────────────────────────────────────────────
step "STEP 13: DTOs"

cat > src/schedule/dto/add-orders.dto.ts << 'EOF'
import { IsString, IsNotEmpty } from 'class-validator';

export class AddOrdersDto {
  @IsString()
  @IsNotEmpty({ message: 'Input tidak boleh kosong' })
  input: string;
}
EOF

cat > src/schedule/dto/update-config.dto.ts << 'EOF'
import {
  IsBoolean, IsNumber, IsObject, IsOptional,
  IsString, Min, Max, IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AssetConfigDto {
  @IsString() ric: string;
  @IsString() name: string;
}

export class MartingaleDto {
  @IsBoolean() isEnabled: boolean;
  @IsNumber() @Min(1) @Max(10) maxSteps: number;
  @IsNumber() @Min(1) baseAmount: number;
  @IsNumber() @Min(0) multiplierValue: number;
  @IsIn(['FIXED', 'PERCENTAGE']) multiplierType: 'FIXED' | 'PERCENTAGE';
  @IsBoolean() isAlwaysSignal: boolean;
}

export class UpdateScheduleConfigDto {
  @IsObject() @Type(() => AssetConfigDto) asset: AssetConfigDto;
  @IsObject() @Type(() => MartingaleDto) martingale: MartingaleDto;
  @IsBoolean() isDemoAccount: boolean;
  @IsString() currency: string;
  @IsString() currencyIso: string;
  @IsOptional() @IsNumber() @Min(1) duration?: number;
}
EOF
log "DTOs ditulis ✅"

# ────────────────────────────────────────────────
# STEP 14: Schedule Service
# ────────────────────────────────────────────────
step "STEP 14: Schedule Service"

cat > src/schedule/schedule.service.ts << 'EOF'
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { AuthService } from '../auth/auth.service';
import { StockityWebSocketClient } from './websocket-client';
import { ScheduleExecutor, ExecutorCallbacks } from './schedule-executor';
import { UpdateScheduleConfigDto } from './dto/update-config.dto';
import { ScheduledOrder, ScheduleConfig, ExecutionLog } from './types';
import { v4 as uuidv4 } from 'uuid';

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;

const DEFAULT_CONFIG: ScheduleConfig = {
  asset: { ric: 'EURUSD_otc', name: 'EUR/USD' },
  martingale: {
    isEnabled: true, maxSteps: 2,
    baseAmount: 1400000, multiplierValue: 2.5,
    multiplierType: 'FIXED', isAlwaysSignal: false,
  },
  isDemoAccount: true,
  currency: 'IDR', currencyIso: 'IDR', duration: 1,
};

@Injectable()
export class ScheduleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduleService.name);
  private executors = new Map<string, ScheduleExecutor>();
  private wsClients = new Map<string, StockityWebSocketClient>();
  private logs = new Map<string, ExecutionLog[]>();
  private configs = new Map<string, ScheduleConfig>();

  constructor(
    private readonly firebaseService: FirebaseService,
    private readonly authService: AuthService,
  ) {}

  async onModuleInit() {
    this.logger.log('ScheduleService init – restoring active sessions...');
    await this.restoreActiveSessions();
  }

  async onModuleDestroy() {
    for (const [, exec] of this.executors) exec.stop();
    for (const [, ws] of this.wsClients) ws.disconnect();
  }

  // ── Restore ──────────────────────────────────

  private async restoreActiveSessions() {
    try {
      const snap = await this.firebaseService.db
        .collection('schedule_status')
        .where('botState', 'in', ['RUNNING', 'PAUSED'])
        .get();
      for (const doc of snap.docs) {
        const userId = doc.id;
        const wasState = doc.data().botState;
        this.logger.log(`Restoring ${userId} (was ${wasState})`);
        try {
          await this.startSchedule(userId);
          if (wasState === 'PAUSED') {
            this.executors.get(userId)?.pause();
            await this.updateStatus(userId, 'PAUSED');
          }
        } catch (err: any) {
          this.logger.error(`Restore failed for ${userId}: ${err.message}`);
          await this.updateStatus(userId, 'STOPPED').catch(() => {});
        }
      }
    } catch (err: any) {
      this.logger.error(`restoreActiveSessions error: ${err.message}`);
    }
  }

  // ── Config ────────────────────────────────────

  async getConfig(userId: string): Promise<ScheduleConfig> {
    if (this.configs.has(userId)) return this.configs.get(userId)!;
    const doc = await this.firebaseService.db.collection('schedule_configs').doc(userId).get();
    if (doc.exists) {
      const d = doc.data() as any;
      const cfg: ScheduleConfig = {
        asset: d.asset || DEFAULT_CONFIG.asset,
        martingale: d.martingale || DEFAULT_CONFIG.martingale,
        isDemoAccount: d.isDemoAccount ?? true,
        currency: d.currency || 'IDR',
        currencyIso: d.currencyIso || 'IDR',
        duration: d.duration || 1,
      };
      this.configs.set(userId, cfg);
      return cfg;
    }
    const def = { ...DEFAULT_CONFIG };
    this.configs.set(userId, def);
    return def;
  }

  async updateConfig(userId: string, dto: UpdateScheduleConfigDto): Promise<ScheduleConfig> {
    const cfg: ScheduleConfig = {
      asset: dto.asset, martingale: dto.martingale,
      isDemoAccount: dto.isDemoAccount,
      currency: dto.currency, currencyIso: dto.currencyIso,
      duration: dto.duration ?? 1,
    };
    this.configs.set(userId, cfg);
    await this.firebaseService.db.collection('schedule_configs').doc(userId).set(
      { ...cfg, updatedAt: this.firebaseService.FieldValue.serverTimestamp() },
      { merge: true },
    );
    this.executors.get(userId)?.updateConfig(cfg);
    return cfg;
  }

  // ── Orders ────────────────────────────────────

  async getOrders(userId: string): Promise<ScheduledOrder[]> {
    const exec = this.executors.get(userId);
    if (exec) return exec.getOrders();
    const doc = await this.firebaseService.db.collection('schedule_configs').doc(userId).get();
    if (doc.exists) return (doc.data() as any)?.orders || [];
    return [];
  }

  async addOrders(userId: string, input: string) {
    const { orders, errors } = this.parseInput(input);
    if (orders.length === 0) {
      return { added: 0, errors, message: errors.join(', ') || 'Tidak ada jadwal valid' };
    }

    const exec = this.executors.get(userId);
    if (exec) {
      const added = exec.addOrders(orders);
      await this.saveOrders(userId, exec.getOrders());
      return { added: added.length, errors, message: `${added.length} jadwal ditambahkan` };
    }

    // Bot tidak running – simpan langsung ke Firebase
    const existing = await this.getOrders(userId);
    const keys = new Set(existing.map(o => `${o.time}_${o.trend}`));
    const newOnes = orders.filter(o => !keys.has(`${o.time}_${o.trend}`));
    const all = [...existing, ...newOnes].sort((a, b) => a.timeInMillis - b.timeInMillis);
    await this.saveOrders(userId, all);
    return { added: newOnes.length, errors, message: `${newOnes.length} jadwal disimpan` };
  }

  async removeOrder(userId: string, orderId: string) {
    const exec = this.executors.get(userId);
    if (exec) {
      exec.removeOrder(orderId);
      await this.saveOrders(userId, exec.getOrders());
    } else {
      const orders = (await this.getOrders(userId)).filter(o => o.id !== orderId);
      await this.saveOrders(userId, orders);
    }
    return { message: 'Order dihapus' };
  }

  async clearOrders(userId: string) {
    const exec = this.executors.get(userId);
    if (exec) exec.clearOrders();
    await this.saveOrders(userId, []);
    return { message: 'Semua order dihapus' };
  }

  private async saveOrders(userId: string, orders: ScheduledOrder[]) {
    await this.firebaseService.db.collection('schedule_configs').doc(userId).set(
      { orders, updatedAt: this.firebaseService.FieldValue.serverTimestamp() },
      { merge: true },
    );
  }

  // ── Control ───────────────────────────────────

  async startSchedule(userId: string) {
    const existing = this.executors.get(userId);
    if (existing?.getBotState() === 'RUNNING') {
      return { message: 'Schedule sudah berjalan', status: existing.getStatus() };
    }

    const session = await this.authService.getSession(userId);
    if (!session) throw new Error('Session tidak ditemukan. Silakan login ulang.');

    const config = await this.getConfig(userId);
    if (!config.asset?.ric) throw new Error('Asset belum dikonfigurasi');

    const orders = await this.getOrders(userId);

    const ws = new StockityWebSocketClient(
      userId, session.stockityToken, session.deviceId,
      session.deviceType || 'web', session.userAgent,
    );

    ws.setOnStatusChange((connected, reason) => {
      this.logger.log(`[${userId}] WS: ${connected ? 'Connected' : 'Disconnected'} ${reason || ''}`);
    });

    await ws.connect();
    this.wsClients.set(userId, ws);

    if (!this.logs.has(userId)) this.logs.set(userId, []);

    const callbacks: ExecutorCallbacks = {
      onOrdersUpdate: async (o) => { await this.saveOrders(userId, o).catch(() => {}); },
      onLog: async (log) => {
        const arr = this.logs.get(userId) || [];
        arr.push(log);
        if (arr.length > 500) arr.splice(0, arr.length - 500);
        this.logs.set(userId, arr);
        await this.appendLog(userId, log).catch(() => {});
      },
      onAllCompleted: async () => {
        this.logger.log(`[${userId}] All completed`);
        await this.updateStatus(userId, 'STOPPED');
        this.cleanup(userId);
      },
      onStatusChange: (s) => this.logger.debug(`[${userId}] ${s}`),
    };

    const exec = new ScheduleExecutor(userId, ws, callbacks, orders, config);
    this.executors.set(userId, exec);
    exec.start();

    await this.updateStatus(userId, 'RUNNING');
    return { message: 'Schedule dimulai', status: exec.getStatus() };
  }

  async stopSchedule(userId: string) {
    const exec = this.executors.get(userId);
    if (!exec) return { message: 'Schedule tidak berjalan' };
    exec.stop();
    await this.saveOrders(userId, exec.getOrders());
    await this.updateStatus(userId, 'STOPPED');
    this.cleanup(userId);
    return { message: 'Schedule dihentikan' };
  }

  async pauseSchedule(userId: string) {
    const exec = this.executors.get(userId);
    if (!exec || exec.getBotState() !== 'RUNNING') return { message: 'Schedule tidak berjalan' };
    exec.pause();
    await this.updateStatus(userId, 'PAUSED');
    return { message: 'Schedule dijeda' };
  }

  async resumeSchedule(userId: string) {
    const exec = this.executors.get(userId);
    if (!exec || exec.getBotState() !== 'PAUSED') return { message: 'Schedule tidak dalam kondisi paused', status: {} };
    exec.resume();
    await this.updateStatus(userId, 'RUNNING');
    return { message: 'Schedule dilanjutkan', status: exec.getStatus() };
  }

  async getStatus(userId: string): Promise<object> {
    const exec = this.executors.get(userId);
    if (exec) {
      return {
        ...exec.getStatus(),
        orders: exec.getOrders(),
        alwaysSignalLossState: exec.getAlwaysSignalLossState(),
      };
    }
    const statusDoc = await this.firebaseService.db.collection('schedule_status').doc(userId).get();
    const orders = await this.getOrders(userId);
    return {
      botState: statusDoc.exists ? statusDoc.data()?.botState ?? 'STOPPED' : 'STOPPED',
      totalOrders: orders.length,
      pendingOrders: orders.filter(o => !o.isExecuted && !o.isSkipped).length,
      executedOrders: orders.filter(o => o.isExecuted).length,
      skippedOrders: orders.filter(o => o.isSkipped).length,
      activeMartingaleOrderId: null,
      wsConnected: false,
      orders,
    };
  }

  async getLogs(userId: string, limit = 100): Promise<ExecutionLog[]> {
    const mem = this.logs.get(userId) || [];
    if (mem.length > 0) return mem.slice(-limit);
    const snap = await this.firebaseService.db
      .collection('schedule_logs').doc(userId)
      .collection('entries')
      .orderBy('executedAt', 'desc').limit(limit).get();
    return snap.docs.map(d => d.data() as ExecutionLog);
  }

  // ── Input Parser (sama dengan ScheduleManager Android) ──

  parseInput(input: string): { orders: ScheduledOrder[]; errors: string[] } {
    const orders: ScheduledOrder[] = [];
    const errors: string[] = [];
    const lines = input.trim().split('\n').map(l => l.trim().replace(/\s+/g, ' ')).filter(Boolean);

    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].split(' ');
      if (parts.length !== 2) { errors.push(`Baris ${i + 1}: format salah '${lines[i]}'`); continue; }
      const [timeStr, trendRaw] = parts;
      const trendUp = trendRaw.toUpperCase();
      if (!/^\d{1,2}[:.]\d{2}$/.test(timeStr)) { errors.push(`Baris ${i + 1}: jam tidak valid '${timeStr}'`); continue; }
      if (!['B', 'S', 'BUY', 'SELL', 'CALL', 'PUT'].includes(trendUp)) { errors.push(`Baris ${i + 1}: arah tidak valid '${trendRaw}'`); continue; }
      const trend = ['B', 'BUY', 'CALL'].includes(trendUp) ? 'call' : 'put';
      const [h, m] = timeStr.split(/[:.]/).map(Number);
      if (h < 0 || h > 23 || m < 0 || m > 59) { errors.push(`Baris ${i + 1}: waktu di luar rentang`); continue; }
      const timeInMillis = this.toJakartaMs(h, m);
      orders.push({
        id: uuidv4(),
        time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
        trend: trend as any,
        timeInMillis,
        isExecuted: false, isSkipped: false,
        martingaleState: { isActive: false, currentStep: 0, maxSteps: 10, isCompleted: false, totalLoss: 0, totalRecovered: 0 },
      });
    }
    orders.sort((a, b) => a.timeInMillis - b.timeInMillis);
    return { orders, errors };
  }

  private toJakartaMs(hour: number, minute: number): number {
    const jakartaNow = new Date(Date.now() + JAKARTA_OFFSET_MS);
    const target = new Date(jakartaNow);
    target.setHours(hour, minute, 0, 0);
    let utcMs = target.getTime() - JAKARTA_OFFSET_MS;
    if (utcMs <= Date.now()) utcMs += 86400000;
    return utcMs;
  }

  // ── Firebase helpers ──────────────────────────

  private async updateStatus(userId: string, botState: string) {
    const extra: any = {};
    if (botState === 'RUNNING') extra.startedAt = this.firebaseService.FieldValue.serverTimestamp();
    if (botState === 'STOPPED') extra.stoppedAt = this.firebaseService.FieldValue.serverTimestamp();
    await this.firebaseService.db.collection('schedule_status').doc(userId).set(
      { botState, updatedAt: this.firebaseService.FieldValue.serverTimestamp(), ...extra },
      { merge: true },
    );
  }

  private async appendLog(userId: string, log: ExecutionLog) {
    await this.firebaseService.db
      .collection('schedule_logs').doc(userId)
      .collection('entries').doc(log.id)
      .set({ ...log, executedAt: this.firebaseService.Timestamp.fromMillis(log.executedAt) });
  }

  private cleanup(userId: string) {
    this.wsClients.get(userId)?.disconnect();
    this.wsClients.delete(userId);
    this.executors.delete(userId);
  }
}
EOF
log "Schedule service ditulis ✅"

# ────────────────────────────────────────────────
# STEP 15: Schedule Controller & Module
# ────────────────────────────────────────────────
step "STEP 15: Schedule Controller & Module"

cat > src/schedule/schedule.controller.ts << 'EOF'
import {
  Body, Controller, Delete, Get, Param,
  Post, Put, Query, Request, UseGuards, HttpCode,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ScheduleService } from './schedule.service';
import { AddOrdersDto } from './dto/add-orders.dto';
import { UpdateScheduleConfigDto } from './dto/update-config.dto';

@UseGuards(JwtAuthGuard)
@Controller('schedule')
export class ScheduleController {
  constructor(private readonly svc: ScheduleService) {}

  @Get('config')
  getConfig(@Request() req) { return this.svc.getConfig(req.user.userId); }

  @Put('config')
  updateConfig(@Request() req, @Body() dto: UpdateScheduleConfigDto) {
    return this.svc.updateConfig(req.user.userId, dto);
  }

  @Get('orders')
  getOrders(@Request() req) { return this.svc.getOrders(req.user.userId); }

  @Post('orders')
  @HttpCode(200)
  addOrders(@Request() req, @Body() dto: AddOrdersDto) {
    return this.svc.addOrders(req.user.userId, dto.input);
  }

  @Delete('orders/:id')
  removeOrder(@Request() req, @Param('id') id: string) {
    return this.svc.removeOrder(req.user.userId, id);
  }

  @Delete('orders')
  clearOrders(@Request() req) { return this.svc.clearOrders(req.user.userId); }

  @Post('start')
  @HttpCode(200)
  start(@Request() req) { return this.svc.startSchedule(req.user.userId); }

  @Post('stop')
  @HttpCode(200)
  stop(@Request() req) { return this.svc.stopSchedule(req.user.userId); }

  @Post('pause')
  @HttpCode(200)
  pause(@Request() req) { return this.svc.pauseSchedule(req.user.userId); }

  @Post('resume')
  @HttpCode(200)
  resume(@Request() req) { return this.svc.resumeSchedule(req.user.userId); }

  @Get('status')
  status(@Request() req) { return this.svc.getStatus(req.user.userId); }

  @Get('logs')
  logs(@Request() req, @Query('limit') limit?: string) {
    return this.svc.getLogs(req.user.userId, limit ? parseInt(limit) : 100);
  }

  @Post('parse')
  @HttpCode(200)
  parse(@Body() dto: AddOrdersDto) { return this.svc.parseInput(dto.input); }
}
EOF

cat > src/schedule/schedule.module.ts << 'EOF'
import { Module } from '@nestjs/common';
import { ScheduleController } from './schedule.controller';
import { ScheduleService } from './schedule.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [ScheduleController],
  providers: [ScheduleService],
})
export class ScheduleAppModule {}
EOF
log "Schedule controller & module ditulis ✅"

# ────────────────────────────────────────────────
# STEP 16: App Root
# ────────────────────────────────────────────────
step "STEP 16: App Root"

cat > src/app.module.ts << 'EOF'
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { FirebaseModule } from './firebase/firebase.module';
import { AuthModule } from './auth/auth.module';
import { ProfileModule } from './profile/profile.module';
import { ScheduleAppModule } from './schedule/schedule.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    FirebaseModule,
    AuthModule,
    ProfileModule,
    ScheduleAppModule,
  ],
})
export class AppModule {}
EOF

cat > src/main.ts << 'EOF'
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: false,
    transform: true,
  }));

  app.setGlobalPrefix('api/v1');

  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0');

  logger.log(`🚀 Stockity Schedule VPS running on port ${port}`);
  logger.log(`📡 API: http://localhost:${port}/api/v1`);
}
bootstrap();
EOF
log "App root ditulis ✅"

# ────────────────────────────────────────────────
# STEP 17: npm install & build
# ────────────────────────────────────────────────
step "STEP 17: npm install"
npm install
log "Dependencies terinstall ✅"

step "STEP 18: Build"
npm run build
log "Build sukses ✅"

# ────────────────────────────────────────────────
# STEP 19: Git init
# ────────────────────────────────────────────────
step "STEP 19: Git init"
if [ ! -d ".git" ]; then
  git init
  git add .
  git commit -m "feat: initial stockity schedule vps backend"
  log "Git repository initialized dan initial commit dibuat ✅"
else
  log "Git repository sudah ada, skip git init."
fi

# ────────────────────────────────────────────────
# SELESAI
# ────────────────────────────────────────────────
step "✅ SETUP WINDOWS SELESAI!"

echo ""
echo -e "${YELLOW}╔══════════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${YELLOW}║                   LANGKAH SELANJUTNYA                               ║${NC}"
echo -e "${YELLOW}╚══════════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${CYAN}1. Setup Firebase (WAJIB sebelum run):${NC}"
echo "   → Buka https://console.firebase.google.com"
echo "   → Project Settings → Service Accounts → Generate new private key"
echo "   → Simpan file JSON sebagai: firebase-service-account.json (di root project)"
echo "   → Buat Firestore Database (mode Production, region asia-southeast1)"
echo ""
echo -e "${CYAN}2. Buat .env dari template:${NC}"
echo "   cp .env.example .env"
echo "   → Edit .env, isi JWT_SECRET dengan string random panjang"
echo "   → Pastikan FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json"
echo "   INGAT: .env dan firebase-service-account.json TIDAK akan ter-push ke git!"
echo ""
echo -e "${CYAN}3. Test di lokal (opsional):${NC}"
echo "   npm run start:dev"
echo "   → Akses: http://localhost:3000/api/v1"
echo ""
echo -e "${CYAN}4. Push ke Git:${NC}"
echo "   git remote add origin https://github.com/USERNAME/REPO.git"
echo "   git push -u origin main"
echo ""
echo -e "${CYAN}5. Di VPS, jalankan vps-deploy.sh:${NC}"
echo "   bash vps-deploy.sh https://github.com/USERNAME/REPO.git"
echo "   → Script ini akan clone repo, install Node/PM2, setup .env di VPS,"
echo "     build, dan start dengan PM2 otomatis"
echo ""
echo -e "${GREEN}Project siap! Folder: $(pwd)${NC}"