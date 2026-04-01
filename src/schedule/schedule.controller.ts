import {
  Body, Controller, Delete, Get, Param,
  Post, Put, Query, Request, UseGuards, HttpCode,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ScheduleService } from './schedule.service';
import { AddOrdersDto } from './dto/add-orders.dto';
import { UpdateScheduleConfigDto } from './dto/update-config.dto';

@UseGuards(JwtAuthGuard)
@Controller('schedule')
export class ScheduleController {
  constructor(private readonly svc: ScheduleService) {}

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
  start(@Request() req) { return this.svc.startSchedule(req.user.userId); }

  @Post('stop')
  @HttpCode(200)
  stop(@Request() req) { return this.svc.stopSchedule(req.user.userId); }

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
}