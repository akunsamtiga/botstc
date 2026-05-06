import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';

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

  app.enableCors({
    origin: [
      'https://v2.stcautotrade.id',
      'https://stcautotradepro.id',
      'http://localhost:3000',
      'http://localhost:3001',
      'https://bot.stcautotrade.id',
      'https://localhost',
      'capacitor://localhost',
      'ionic://localhost',
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
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
  logger.log(`✅ CORS enabled for: v2.stcautotrade.id`);

  // AI Signal Mode Info
  logger.log(`🤖 AI Signal Mode: ENABLED`);
  logger.log(`📱 FCM Topic: trading_signals`);
  logger.log(`🔍 Trade Monitoring: Active (50ms interval)`);
}
bootstrap();