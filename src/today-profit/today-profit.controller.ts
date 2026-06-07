// src/today-profit/today-profit.controller.ts
import {
  Controller,
  Get,
  Query,
  Param,
  Request,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TodayProfitService } from './today-profit.service';

@UseGuards(JwtAuthGuard)
@Controller('today-profit')
export class TodayProfitController {
  constructor(private readonly todayProfitService: TodayProfitService) {}

  /**
   * GET /today-profit
   * Get today's profit summary across all trading modes + Stockity API.
   *
   * Query params:
   *   - date:        optional, YYYY-MM-DD (default: today)
   *   - accountType: 'real' | 'demo' | 'both' (default: 'real')
   *                  Mengontrol mode logs Supabase DAN Stockity API yang difetch.
   *                  'real'  → hanya trade real
   *                  'demo'  → hanya trade demo
   *                  'both'  → semua trade (real + demo digabung)
   */
  @Get()
  @HttpCode(200)
  async getTodayProfit(
    @Request() req,
    @Query('date') date?: string,
    @Query('accountType') accountType?: 'real' | 'demo' | 'both',
  ) {
    const result = await this.todayProfitService.getTodayProfit(
      req.user.userId,
      date,
      accountType ?? 'real',
    );
    return { success: true, data: result };
  }

  /**
   * GET /today-profit/history
   * Get profit history for a date range (day by day).
   *
   * Query params:
   *   - startDate:   required, YYYY-MM-DD
   *   - endDate:     required, YYYY-MM-DD
   *   - accountType: 'real' | 'demo' | 'both' (default: 'real')
   */
  @Get('history')
  @HttpCode(200)
  async getProfitHistory(
    @Request() req,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('accountType') accountType?: 'real' | 'demo' | 'both',
  ) {
    if (!startDate || !endDate) {
      return {
        success: false,
        error: 'startDate and endDate are required (YYYY-MM-DD format)',
      };
    }
    const result = await this.todayProfitService.getProfitHistory(
      req.user.userId,
      startDate,
      endDate,
      accountType ?? 'real',
    );
    return { success: true, data: result };
  }

  /**
   * GET /today-profit/realtime
   * Get real-time profit including active sessions.
   * Menggunakan Stockity cache — response cepat (~200ms).
   *
   * Query params:
   *   - accountType: 'real' | 'demo' | 'both' (default: 'real')
   *                  Harus konsisten dengan parameter yang dipakai di GET /today-profit
   *                  agar deduplication UUID bekerja dengan benar.
   */
  @Get('realtime')
  @HttpCode(200)
  async getRealtimeProfit(
    @Request() req,
    @Query('accountType') accountType?: 'real' | 'demo' | 'both',
  ) {
    const result = await this.todayProfitService.getRealtimeProfit(
      req.user.userId,
      accountType ?? 'real',
    );
    return { success: true, data: result };
  }

  /**
   * GET /today-profit/by-mode/:mode
   * Get profit summary untuk mode trading tertentu (schedule, fastrade, aisignal, indicator, momentum).
   */
  @Get('by-mode/:mode')
  @HttpCode(200)
  async getProfitByMode(
    @Request() req,
    @Param('mode') mode: string,
    @Query('date') date?: string,
    @Query('accountType') accountType?: 'real' | 'demo' | 'both',
  ) {
    const summary = await this.todayProfitService.getTodayProfit(
      req.user.userId,
      date,
      accountType ?? 'real',
    );
    const modeData = summary.byMode[mode] ?? {
      mode,
      pnl: 0,
      trades: 0,
      wins: 0,
      losses: 0,
      draws: 0,
    };
    const byAsset: Record<string, any> = {};
    for (const [ric, asset] of Object.entries(summary.byAsset)) {
      byAsset[ric] = asset;
    }
    return {
      success: true,
      data: {
        ...summary,
        byMode: { [mode]: modeData },
        totalPnL: modeData.pnl,
        totalTrades: modeData.trades,
        totalWins: modeData.wins,
        totalLosses: modeData.losses,
        totalDraws: modeData.draws,
        winRate: modeData.trades > 0
          ? Math.round((modeData.wins / modeData.trades) * 100)
          : 0,
      },
    };
  }
}