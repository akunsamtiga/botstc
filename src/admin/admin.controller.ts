import {
  Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Request, UseGuards, HttpCode,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard, SuperAdminGuard } from './admin.guard';
import { AdminService } from './admin.service';

@UseGuards(JwtAuthGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly svc: AdminService) {}

  // ── Self (cukup login) ─────────────────────────────────────────────────────
  /** Status role user saat ini — menggantikan checkIsAdmin/checkIsSuperAdmin dari anon. */
  @Get('me')
  me(@Request() req) {
    return this.svc.getMe(req.user.email);
  }

  /** Self-registration whitelist — user menambahkan DIRINYA sendiri (email & userId dari JWT). */
  @Post('whitelist/self')
  @HttpCode(200)
  selfRegister(@Request() req, @Body() body: { name?: string; deviceId?: string; isPrimary?: boolean; addedBy?: string }) {
    return this.svc.selfRegister(req.user.email, req.user.userId, body ?? {});
  }

  // ── Whitelist (admin) ──────────────────────────────────────────────────────
  @UseGuards(AdminGuard)
  @Get('whitelist')
  async listWhitelist(@Request() req) {
    const { isSuperAdmin } = await this.svc.getMe(req.user.email);
    return this.svc.listWhitelist(req.user.email, isSuperAdmin);
  }

  @UseGuards(AdminGuard)
  @Get('stats')
  async stats(@Request() req) {
    const { isSuperAdmin } = await this.svc.getMe(req.user.email);
    return this.svc.stats(req.user.email, isSuperAdmin);
  }

  @UseGuards(AdminGuard)
  @Post('whitelist')
  @HttpCode(200)
  addWhitelist(@Request() req, @Body() body: { email: string; name?: string; userId?: string; deviceId?: string; isPrimary?: boolean; addedBy?: string }) {
    return this.svc.addWhitelist(body, body.addedBy ?? req.user.email);
  }

  @UseGuards(AdminGuard)
  @Patch('whitelist')
  @HttpCode(200)
  updateWhitelist(@Body() body: { oldEmail: string; email?: string; name?: string; userId?: string; deviceId?: string; isActive?: boolean; lastLogin?: number | null }) {
    const { oldEmail, ...updates } = body;
    return this.svc.updateWhitelist(oldEmail, updates);
  }

  @UseGuards(AdminGuard)
  @Post('whitelist/toggle')
  @HttpCode(200)
  toggleWhitelist(@Body() body: { email: string; isActive: boolean }) {
    return this.svc.toggleWhitelist(body.email, body.isActive);
  }

  @UseGuards(AdminGuard)
  @Delete('whitelist')
  @HttpCode(200)
  deleteWhitelist(@Query('id') id: string, @Body() body?: { id?: string }) {
    return this.svc.deleteWhitelist(id ?? body?.id ?? '');
  }

  @UseGuards(AdminGuard)
  @Post('whitelist/import')
  @HttpCode(200)
  importWhitelist(@Request() req, @Body() body: { rows: any[]; addedBy?: string }) {
    return this.svc.importWhitelist(body.rows ?? [], body.addedBy ?? req.user.email);
  }

  // ── Admin users (super admin) ──────────────────────────────────────────────
  @UseGuards(AdminGuard)
  @Get('admins')
  listAdmins() {
    return this.svc.listAdmins();
  }

  @UseGuards(SuperAdminGuard)
  @Post('admins')
  @HttpCode(200)
  addAdmin(@Body() body: { email: string; name?: string; role?: string }) {
    return this.svc.addAdmin(body.email, body.name, body.role);
  }

  @UseGuards(SuperAdminGuard)
  @Patch('admins/:id')
  @HttpCode(200)
  updateAdmin(@Param('id') id: string, @Body() body: { name?: string; role?: 'admin' | 'super_admin'; is_active?: boolean }) {
    return this.svc.updateAdmin(id, body);
  }

  @UseGuards(SuperAdminGuard)
  @Delete('admins')
  @HttpCode(200)
  removeAdmin(@Query('id') id: string, @Body() body?: { id?: string }) {
    return this.svc.removeAdmin(id ?? body?.id ?? '');
  }

  // ── Super admins (super admin) ─────────────────────────────────────────────
  @UseGuards(AdminGuard)
  @Get('super-admins')
  listSuperAdmins() {
    return this.svc.listSuperAdmins();
  }

  @UseGuards(SuperAdminGuard)
  @Post('super-admins')
  @HttpCode(200)
  addSuperAdmin(@Body() body: { email: string }) {
    return this.svc.addSuperAdmin(body.email);
  }

  @UseGuards(SuperAdminGuard)
  @Delete('super-admins')
  @HttpCode(200)
  deleteSuperAdmin(@Query('email') email: string, @Body() body?: { email?: string }) {
    return this.svc.deleteSuperAdmin(email ?? body?.email ?? '');
  }

  // ── Config (admin) ─────────────────────────────────────────────────────────
  @UseGuards(AdminGuard)
  @Put('config')
  @HttpCode(200)
  upsertConfig(@Body() body: { key: string; value: unknown }) {
    return this.svc.upsertConfig(body.key, body.value);
  }
}
