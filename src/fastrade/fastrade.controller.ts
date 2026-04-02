import {
  Body, Controller, Get, Post,
  Query, Request, UseGuards, HttpCode,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FastradeService } from './fastrade.service';
import { StartFastradeDto } from './dto/start-fastrade.dto';

@UseGuards(JwtAuthGuard)
@Controller('fastrade')
export class FastradeController {
  constructor(private readonly svc: FastradeService) {}

  /**
   * POST /fastrade/start
   * Mulai mode FTT atau CTC.
   *
   * Body: StartFastradeDto
   *   mode: 'FTT' | 'CTC'
   *   asset: { ric, name, profitRate? }
   *   martingale: { isEnabled, maxSteps, baseAmount, multiplierValue, multiplierType }
   *   isDemoAccount: boolean
   *   currency: string
   *   currencyIso: string
   *   stopLoss?: number   (0 = nonaktif)
   *   stopProfit?: number (0 = nonaktif)
   */
  @Post('start')
  @HttpCode(200)
  start(@Request() req, @Body() dto: StartFastradeDto) {
    return this.svc.start(req.user.userId, dto);
  }

  /**
   * POST /fastrade/stop
   * Hentikan mode FTT/CTC yang sedang berjalan.
   */
  @Post('stop')
  @HttpCode(200)
  stop(@Request() req) {
    return this.svc.stop(req.user.userId);
  }

  /**
   * GET /fastrade/status
   * Status bot: mode, phase, trend, martingale, P&L, dll.
   */
  @Get('status')
  status(@Request() req) {
    return this.svc.getStatus(req.user.userId);
  }

  /**
   * GET /fastrade/logs?limit=100
   * Ambil log eksekusi terakhir.
   */
  @Get('logs')
  logs(@Request() req, @Query('limit') limit?: string) {
    return this.svc.getLogs(req.user.userId, limit ? parseInt(limit, 10) : 100);
  }
}