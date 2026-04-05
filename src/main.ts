import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
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
    credentials: true, // Penting untuk cookies/auth
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
}
bootstrap();