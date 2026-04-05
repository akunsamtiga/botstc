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
import { MomentumService } from './momentum.service';
import { UpdateMomentumConfigDto } from './dto/update-config.dto';
import { MomentumType } from './types';

@UseGuards(JwtAuthGuard)
@Controller('momentum')
export class MomentumController {
  constructor(private readonly svc: MomentumService) {}

  // ==================== CONFIG ====================
  @Get('config')
  async getConfig(@Request() req) {
    return this.svc.getConfig(req.user.userId);
  }

  @Put('config')
  async updateConfig(@Request() req, @Body() dto: UpdateMomentumConfigDto) {
    const config = await this.svc.getConfig(req.user.userId);

    const updates: any = {};

    if (
      dto.candleSabitEnabled !== undefined ||
      dto.dojiTerjepitEnabled !== undefined ||
      dto.dojiPembatalanEnabled !== undefined ||
      dto.bbSarBreakEnabled !== undefined
    ) {
      updates.enabledMomentums = {
        candleSabit: dto.candleSabitEnabled ?? config.enabledMomentums.candleSabit,
        dojiTerjepit: dto.dojiTerjepitEnabled ?? config.enabledMomentums.dojiTerjepit,
        dojiPembatalan: dto.dojiPembatalanEnabled ?? config.enabledMomentums.dojiPembatalan,
        bbSarBreak: dto.bbSarBreakEnabled ?? config.enabledMomentums.bbSarBreak,
      };
    }

    if (
      dto.maxSteps !== undefined ||
      dto.multiplierValue !== undefined ||
      dto.baseAmount !== undefined
    ) {
      updates.martingale = {
        ...config.martingale,
        ...(dto.maxSteps && { maxSteps: dto.maxSteps }),
        ...(dto.multiplierValue && { multiplierValue: dto.multiplierValue }),
        ...(dto.baseAmount && { baseAmount: dto.baseAmount }),
      };
    }

    return this.svc.updateConfig(req.user.userId, updates);
  }

  @Put('config/asset')
  async setAsset(@Request() req, @Body() body: { ric: string; name: string }) {
    return this.svc.updateConfig(req.user.userId, { asset: body });
  }

  @Put('config/account')
  async setAccountType(@Request() req, @Body() body: { isDemoAccount: boolean }) {
    return this.svc.updateConfig(req.user.userId, { isDemoAccount: body.isDemoAccount });
  }

  // ==================== CONTROL ====================
  @Post('start')
  @HttpCode(200)
  async start(@Request() req) {
    return this.svc.startMomentumMode(req.user.userId);
  }

  @Post('stop')
  @HttpCode(200)
  async stop(@Request() req) {
    return this.svc.stopMomentumMode(req.user.userId);
  }

  // ==================== STATUS ====================
  @Get('status')
  async getStatus(@Request() req) {
    return this.svc.getStatus(req.user.userId);
  }

  // FIX: add /momentum/logs endpoint — mirrors /fastrade/logs and /schedule/logs
  @Get('logs')
  async getLogs(@Request() req, @Query('limit') limit?: string) {
    return this.svc.getLogs(req.user.userId, limit ? parseInt(limit, 10) : 100);
  }

  // ==================== INFO ====================
  @Get('info')
  getMomentumInfo() {
    return {
      momentumTypes: Object.values(MomentumType),
      descriptions: {
        [MomentumType.CANDLE_SABIT]: 'Deteksi candle dengan body yang membesar berturut-turut',
        [MomentumType.DOJI_TERJEPIT]: 'Deteksi doji setelah 3 candle panjang (sinyal pembalikan)',
        [MomentumType.DOJI_PEMBATALAN]: 'Deteksi doji sebagai sinyal pembatalan/reversal',
        [MomentumType.BB_SAR_BREAK]: 'Breakout Bollinger Bands dengan konfirmasi Parabolic SAR',
      },
      antiOverTrading: {
        signalCooldownMs: 180000,
        priceMoveThreshold: 0.0003,
        maxSignalsPerHour: 10,
      },
    };
  }
}