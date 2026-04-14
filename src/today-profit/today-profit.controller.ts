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
   *                  Controls which Stockity account type is fetched from the API.
   *                  Firebase mode logs are always fetched regardless of this param.
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
    );
    return { success: true, data: result };
  }

  /**
   * GET /today-profit/realtime
   * Get real-time profit including active sessions.
   */
  @Get('realtime')
  @HttpCode(200)
  async getRealtimeProfit(@Request() req) {
    const result = await this.todayProfitService.getRealtimeProfit(req.user.userId);
    return { success: true, data: result };
  }

  /**
   * GET /today-profit/by-mode/:mode
   * Placeholder for mode-specific detailed view.
   */
  @Get('by-mode/:mode')
  @HttpCode(200)
  async getProfitByMode(
    @Request() req,
    @Param('mode') mode: string,
    @Query('date') date?: string,
  ) {
    return {
      success: true,
      data: { mode, date: date || 'today' },
    };
  }
}