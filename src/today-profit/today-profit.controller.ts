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
   * Get today's profit summary across all trading modes
   * 
   * Query params:
   * - date: optional, format YYYY-MM-DD (default: today)
   */
  @Get()
  @HttpCode(200)
  async getTodayProfit(
    @Request() req,
    @Query('date') date?: string,
  ) {
    const result = await this.todayProfitService.getTodayProfit(req.user.userId, date);
    return {
      success: true,
      data: result,
    };
  }

  /**
   * GET /today-profit/history
   * Get profit history for a date range
   * 
   * Query params:
   * - startDate: required, format YYYY-MM-DD
   * - endDate: required, format YYYY-MM-DD
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
    return {
      success: true,
      data: result,
    };
  }

  /**
   * GET /today-profit/realtime
   * Get real-time profit including active sessions
   */
  @Get('realtime')
  @HttpCode(200)
  async getRealtimeProfit(@Request() req) {
    const result = await this.todayProfitService.getRealtimeProfit(req.user.userId);
    return {
      success: true,
      data: result,
    };
  }

  /**
   * GET /today-profit/by-mode/:mode
   * Get detailed profit for a specific trading mode
   */
  @Get('by-mode/:mode')
  @HttpCode(200)
  async getProfitByMode(
    @Request() req,
    @Param('mode') mode: string,
    @Query('date') date?: string,
  ) {
    // Implementation for mode-specific detailed view
    return {
      success: true,
      data: { mode, date: date || 'today' },
    };
  }
}