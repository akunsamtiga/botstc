import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Request,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AISignalService } from './aisignal.service';
import { UpdateAISignalConfigDto, ReceiveSignalDto } from './dto/update-config.dto';

@UseGuards(JwtAuthGuard)
@Controller('aisignal')
export class AISignalController {
  constructor(private readonly svc: AISignalService) {}

  // ==================== CONFIG ====================
  @Get('config')
  async getConfig(@Request() req) {
    return this.svc.getConfig(req.user.userId);
  }

  @Put('config')
  async updateConfig(@Request() req, @Body() dto: UpdateAISignalConfigDto) {
    const config = await this.svc.getConfig(req.user.userId);
    
    const updates: any = {};
    
    if (dto.baseAmount !== undefined) {
      updates.baseAmount = dto.baseAmount;
    }
    
    if (dto.isDemoAccount !== undefined) {
      updates.isDemoAccount = dto.isDemoAccount;
    }

    if (dto.martingaleEnabled !== undefined ||
        dto.maxSteps !== undefined ||
        dto.multiplierValue !== undefined ||
        dto.isAlwaysSignal !== undefined) {
      updates.martingale = {
        ...config.martingale,
        ...(dto.martingaleEnabled !== undefined && { isEnabled: dto.martingaleEnabled }),
        ...(dto.maxSteps !== undefined && { maxSteps: dto.maxSteps }),
        ...(dto.multiplierValue !== undefined && { multiplierValue: dto.multiplierValue }),
        ...(dto.isAlwaysSignal !== undefined && { isAlwaysSignal: dto.isAlwaysSignal }),
      };
    }

    return this.svc.updateConfig(req.user.userId, updates);
  }

  @Put('config/asset')
  async setAsset(@Request() req, @Body() body: { ric: string; name: string }) {
    return this.svc.updateConfig(req.user.userId, { asset: body });
  }

  // ==================== CONTROL ====================
  @Post('start')
  @HttpCode(200)
  async start(@Request() req) {
    return this.svc.startAISignalMode(req.user.userId);
  }

  @Post('stop')
  @HttpCode(200)
  async stop(@Request() req) {
    return this.svc.stopAISignalMode(req.user.userId);
  }

  // ==================== SIGNAL RECEIVING ====================
  @Post('signal')
  @HttpCode(200)
  async receiveSignal(@Request() req, @Body() dto: ReceiveSignalDto) {
    return this.svc.receiveSignal(req.user.userId, {
      trend: dto.trend,
      executionTime: dto.executionTime,
      originalMessage: dto.originalMessage,
    });
  }

  // ==================== STATUS ====================
  @Get('status')
  async getStatus(@Request() req) {
    return this.svc.getStatus(req.user.userId);
  }

  @Get('orders/pending')
  async getPendingOrders(@Request() req) {
    return this.svc.getPendingOrders(req.user.userId);
  }

  @Get('orders/executed')
  async getExecutedOrders(@Request() req) {
    return this.svc.getExecutedOrders(req.user.userId);
  }

  // ==================== INFO ====================
  @Get('info')
  getAISignalInfo() {
    return {
      description: 'AI Signal Mode - Menerima dan mengeksekusi sinyal trading dari AI/Telegram/FCM',
      features: [
        'Menerima sinyal CALL/PUT dengan waktu eksekusi',
        'Eksekusi otomatis pada waktu yang ditentukan',
        'Martingale standar (lanjut langsung setelah loss)',
        'Always Signal mode (lanjut pada sinyal berikutnya)',
        'Monitoring hasil trade real-time',
      ],
      martingaleModes: {
        standard: 'Martingale langsung setelah loss',
        alwaysSignal: 'Martingale pada sinyal berikutnya (tidak blocking)',
      },
      endpoints: {
        receiveSignal: 'POST /aisignal/signal - Menerima sinyal baru',
      },
    };
  }
}
