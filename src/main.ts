import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import * as fs from 'fs';
import * as path from 'path';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  
  // Check Firebase Service Account
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './firebase-service-account.json';
  const resolvedPath = path.resolve(process.cwd(), serviceAccountPath);
  
  if (fs.existsSync(resolvedPath)) {
    logger.log(`✅ Firebase Service Account found: ${serviceAccountPath}`);
  } else {
    logger.warn(`⚠️ Firebase Service Account NOT found at: ${resolvedPath}`);
    logger.warn(`   Make sure to set FIREBASE_SERVICE_ACCOUNT_PATH in .env`);
  }
  
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: [
      'https://v2.stcautotrade.id',
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