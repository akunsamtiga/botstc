import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';

/**
 * Daftar origin CORS.
 * Origin produksi selalu diizinkan; origin localhost HANYA saat NODE_ENV !== 'production'.
 * Bisa di-override/extend via env CORS_ORIGINS (comma-separated).
 */
function buildCorsOrigins(): string[] {
  const prod = [
    'https://v2.stcautotrade.id',
    'https://stcautotradepro.id',
    'https://bot.stcautotrade.id',
    // Capacitor (mobile app) — origin tetap, bukan localhost dev
    'https://localhost',
    'capacitor://localhost',
    'ionic://localhost',
  ];
  const dev = ['http://localhost:3000', 'http://localhost:3001'];

  const extra = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const isProd = process.env.NODE_ENV === 'production';
  return [...prod, ...(isProd ? [] : dev), ...extra];
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // Check Supabase config
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (supabaseUrl && supabaseKey) {
    logger.log(`✅ Supabase config found (URL: ${supabaseUrl.slice(0, 20)}...)`);
  } else {
    logger.warn(`⚠️ Supabase config missing. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env`);
  }

  const app = await NestFactory.create(AppModule);

  // ── Security headers (H1) ─────────────────────────────────────────────────
  // API JSON murni → matikan CSP/CORP yang tidak relevan & bisa mengganggu.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: false,
    }),
  );

  const corsOrigins = buildCorsOrigins();
  app.enableCors({
    origin: corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));

  app.setGlobalPrefix('api/v1');

  // ── Graceful shutdown (M2) ────────────────────────────────────────────────
  // Memungkinkan OnModuleDestroy dipanggil saat SIGTERM/SIGINT (pm2 reload):
  // executor menutup WebSocket & membersihkan timer agar tidak ada trade ter-orphan.
  app.enableShutdownHooks();

  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0');

  logger.log(`🚀 Stockity Schedule VPS running on port ${port}`);
  logger.log(`📡 API: http://localhost:${port}/api/v1`);
  logger.log(`✅ CORS origins (${corsOrigins.length}): ${corsOrigins.join(', ')}`);

  // AI Signal Mode Info
  logger.log(`🤖 AI Signal Mode: ENABLED`);
  logger.log(`📱 FCM Topic: trading_signals`);
  logger.log(`🔍 Trade Monitoring: Active (50ms interval)`);
}
bootstrap();
