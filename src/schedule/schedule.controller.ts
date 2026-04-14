import {
  Body, Controller, Delete, Get, Param,
  Post, Put, Query, Request, UseGuards, HttpCode,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ScheduleService } from './schedule.service';
import { OrderTrackingService } from './order-tracking.service';
import { AddOrdersDto } from './dto/add-orders.dto';
import { UpdateScheduleConfigDto } from './dto/update-config.dto';
import { OrderTrackingFilterDto } from './dto/order-tracking-filter.dto';

@UseGuards(JwtAuthGuard)
@Controller('schedule')
export class ScheduleController {
  constructor(
    private readonly svc: ScheduleService,
    private readonly trackingService: OrderTrackingService,
  ) {}

  // ── Assets ──────────────────────────────────────────────────────────
  /**
   * GET /schedule/assets
   * Fetch daftar asset langsung dari Stockity API (seperti Kotlin AssetManager).
   * Diurutkan descending berdasarkan profit rate.
   * Gunakan endpoint ini untuk memilih asset sebelum set config.
   */
  @Get('assets')
  getAssets(@Request() req) {
    return this.svc.getAvailableAssets(req.user.userId);
  }

  // ── Config ─────────────────────────────────────────────────────────
  @Get('config')
  getConfig(@Request() req) { return this.svc.getConfig(req.user.userId); }

  @Put('config')
  updateConfig(@Request() req, @Body() dto: UpdateScheduleConfigDto) {
    return this.svc.updateConfig(req.user.userId, dto);
  }

  // ── Orders ─────────────────────────────────────────────────────────
  @Get('orders')
  getOrders(@Request() req) { return this.svc.getOrders(req.user.userId); }

  @Post('orders')
  @HttpCode(200)
  addOrders(@Request() req, @Body() dto: AddOrdersDto) {
    return this.svc.addOrders(req.user.userId, dto.input);
  }

  @Delete('orders/:id')
  removeOrder(@Request() req, @Param('id') id: string) {
    return this.svc.removeOrder(req.user.userId, id);
  }

  @Delete('orders')
  clearOrders(@Request() req) { return this.svc.clearOrders(req.user.userId); }

  // ── Control ────────────────────────────────────────────────────────
  @Post('start')
  @HttpCode(200)
  async start(@Request() req) {
    return this.svc.startSchedule(req.user.userId);
  }

  @Post('stop')
  @HttpCode(200)
  async stop(@Request() req) {
    return this.svc.stopSchedule(req.user.userId);
  }

  @Post('pause')
  @HttpCode(200)
  pause(@Request() req) { return this.svc.pauseSchedule(req.user.userId); }

  @Post('resume')
  @HttpCode(200)
  resume(@Request() req) { return this.svc.resumeSchedule(req.user.userId); }

  // ── Status & Logs ──────────────────────────────────────────────────
  @Get('status')
  status(@Request() req) { return this.svc.getStatus(req.user.userId); }

  @Get('logs')
  logs(@Request() req, @Query('limit') limit?: string) {
    return this.svc.getLogs(req.user.userId, limit ? parseInt(limit) : 100);
  }

  @Post('parse')
  @HttpCode(200)
  parse(@Body() dto: AddOrdersDto) { return this.svc.parseInput(dto.input); }

  // ── Order Tracking / Monitoring ────────────────────────────────────
  /**
   * GET /schedule/tracking
   * Get semua order dengan status tracking lengkap.
   * Response mencakup: PENDING, MONITORING, MARTINGALE_STEP_X, WIN, LOSE, DRAW, FAILED, SKIPPED
   *
   * Query Parameters:
   * - status: Filter berdasarkan status (comma-separated, e.g., "PENDING,MONITORING")
   * - fromTime: Filter dari timestamp (ms)
   * - toTime: Filter sampai timestamp (ms)
   * - onlyActive: true untuk hanya tampilkan order yang masih aktif
   * - limit: Limit jumlah order
   */
  @Get('tracking')
  async getTracking(
    @Request() req,
    @Query() filterDto: OrderTrackingFilterDto,
  ) {
    const tracking = await this.trackingService.getTracking(req.user.userId, {
      status: filterDto.status,
      fromTime: filterDto.fromTime,
      toTime: filterDto.toTime,
      onlyActive: filterDto.onlyActive,
      limit: filterDto.limit,
    });

    if (!tracking) {
      return {
        userId: req.user.userId,
        botState: 'STOPPED',
        orders: [],
        summary: {
          total: 0,
          pending: 0,
          monitoring: 0,
          martingaleActive: 0,
          completed: 0,
          win: 0,
          lose: 0,
          draw: 0,
          failed: 0,
          skipped: 0,
        },
        activeMartingale: null,
        sessionPnL: 0,
        timestamp: Date.now(),
      };
    }

    return tracking;
  }

  /**
   * GET /schedule/tracking/today
   * Get tracking untuk hari ini (berdasarkan waktu Jakarta).
   */
  @Get('tracking/today')
  async getTodayTracking(@Request() req) {
    const tracking = await this.trackingService.getTodayTracking(req.user.userId);

    if (!tracking) {
      return {
        userId: req.user.userId,
        botState: 'STOPPED',
        orders: [],
        summary: {
          total: 0,
          pending: 0,
          monitoring: 0,
          martingaleActive: 0,
          completed: 0,
          win: 0,
          lose: 0,
          draw: 0,
          failed: 0,
          skipped: 0,
        },
        activeMartingale: null,
        sessionPnL: 0,
        timestamp: Date.now(),
      };
    }

    return tracking;
  }

  /**
   * GET /schedule/tracking/active
   * Get hanya order yang masih aktif (PENDING, MONITORING, MARTINGALE).
   */
  @Get('tracking/active')
  async getActiveOrders(@Request() req) {
    const orders = await this.trackingService.getActiveOrders(req.user.userId);
    return {
      userId: req.user.userId,
      orders,
      count: orders.length,
      timestamp: Date.now(),
    };
  }

  /**
   * GET /schedule/tracking/summary
   * Get ringkasan tracking saja (tanpa detail order).
   */
  @Get('tracking/summary')
  async getTrackingSummary(@Request() req) {
    const tracking = await this.trackingService.getTracking(req.user.userId);

    if (!tracking) {
      return {
        userId: req.user.userId,
        botState: 'STOPPED',
        summary: {
          total: 0,
          pending: 0,
          monitoring: 0,
          martingaleActive: 0,
          completed: 0,
          win: 0,
          lose: 0,
          draw: 0,
          failed: 0,
          skipped: 0,
        },
        activeMartingale: null,
        sessionPnL: 0,
        timestamp: Date.now(),
      };
    }

    return {
      userId: req.user.userId,
      botState: tracking.botState,
      summary: tracking.summary,
      activeMartingale: tracking.activeMartingale,
      sessionPnL: tracking.sessionPnL,
      timestamp: tracking.timestamp,
    };
  }

  /**
   * GET /schedule/tracking/order/:id
   * Get detail tracking untuk satu order.
   */
  @Get('tracking/order/:id')
  async getOrderTracking(@Request() req, @Param('id') orderId: string) {
    const tracking = await this.trackingService.getTracking(req.user.userId);

    if (!tracking) {
      return { error: 'No tracking data found' };
    }

    const order = tracking.orders.find(o => o.id === orderId);

    if (!order) {
      return { error: 'Order not found' };
    }

    return {
      userId: req.user.userId,
      order,
      timestamp: Date.now(),
    };
  }
}