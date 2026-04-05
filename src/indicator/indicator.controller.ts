import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Request,
  Query,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { IndicatorService } from './indicator.service';
import { UpdateIndicatorConfigDto } from './dto/update-config.dto';
import { IndicatorType } from './types';

@UseGuards(JwtAuthGuard)
@Controller('indicator')
export class IndicatorController {
  constructor(private readonly svc: IndicatorService) {}

  // ==================== CONFIG ====================
  @Get('config')
  async getConfig(@Request() req) {
    return this.svc.getConfig(req.user.userId);
  }

  @Put('config')
  async updateConfig(@Request() req, @Body() dto: UpdateIndicatorConfigDto) {
    const config = await this.svc.getConfig(req.user.userId);
    
    // Merge existing settings with updates
    const updatedSettings = {
      ...config.settings,
      ...(dto.type && { type: dto.type }),
      ...(dto.period && { period: dto.period }),
      ...(dto.rsiOverbought && { rsiOverbought: dto.rsiOverbought }),
      ...(dto.rsiOversold && { rsiOversold: dto.rsiOversold }),
      ...(dto.isEnabled !== undefined && { isEnabled: dto.isEnabled }),
      ...(dto.sensitivity && { sensitivity: dto.sensitivity }),
      ...(dto.amount && { amount: dto.amount }),
    };

    return this.svc.updateConfig(req.user.userId, { settings: updatedSettings });
  }

  @Put('config/asset')
  async setAsset(@Request() req, @Body() body: { ric: string; name: string }) {
    return this.svc.updateConfig(req.user.userId, { asset: body });
  }

  @Put('config/martingale')
  async setMartingale(@Request() req, @Body() body: {
    isEnabled?: boolean;
    maxSteps?: number;
    baseAmount?: number;
    multiplierValue?: number;
    multiplierType?: 'FIXED' | 'PERCENTAGE';
    isAlwaysSignal?: boolean;
  }) {
    const config = await this.svc.getConfig(req.user.userId);
    const updatedMartingale = { ...config.martingale, ...body };
    return this.svc.updateConfig(req.user.userId, { martingale: updatedMartingale });
  }

  @Put('config/account')
  async setAccountType(@Request() req, @Body() body: { isDemoAccount: boolean }) {
    return this.svc.updateConfig(req.user.userId, { isDemoAccount: body.isDemoAccount });
  }

  // ==================== CONTROL ====================
  @Post('start')
  @HttpCode(200)
  async start(@Request() req) {
    return this.svc.startIndicatorMode(req.user.userId);
  }

  @Post('stop')
  @HttpCode(200)
  async stop(@Request() req) {
    return this.svc.stopIndicatorMode(req.user.userId);
  }

  // ==================== STATUS ====================
  @Get('status')
  async getStatus(@Request() req) {
    return this.svc.getStatus(req.user.userId);
  }

  // ==================== LOGS ====================
  @Get('logs')
  async getLogs(@Request() req, @Query('limit') limit?: string) {
    return this.svc.getLogs(req.user.userId, limit ? parseInt(limit, 10) : 100);
  }

  // ==================== PRESETS ====================
  @Get('presets')
  getPresets() {
    return {
      indicatorTypes: Object.values(IndicatorType),
      defaultSettings: {
        sma: { type: IndicatorType.SMA, period: 14, sensitivity: 0.5 },
        ema: { type: IndicatorType.EMA, period: 9, sensitivity: 0.5 },
        rsi: { type: IndicatorType.RSI, period: 14, rsiOverbought: 70, rsiOversold: 30, sensitivity: 0.5 },
      },
      sensitivityLevels: {
        LOW: 0.1,
        MEDIUM: 1,
        HIGH: 5,
        VERY_HIGH: 10,
        MAX: 100,
      },
    };
  }
}