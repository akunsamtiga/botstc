import {
  Body, Controller, Get, Post,
  Request, UseGuards, HttpCode,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  // Batas lebih ketat dari default global: maksimal 8 percobaan login / menit / IP.
  // Melindungi dari brute-force & credential stuffing yang merotasi email
  // (cooldown per-email di AuthService tidak menangkap rotasi email).
  @Throttle({ default: { ttl: 60_000, limit: 8 } })
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  /**
   * Registrasi whitelist tervalidasi token Stockity (C2).
   * Menggantikan penulisan whitelist_users langsung dari browser saat registrasi.
   */
  @Throttle({ default: { ttl: 60_000, limit: 12 } })
  @Post('register-whitelist')
  @HttpCode(200)
  registerWhitelist(@Body() body: { authToken: string; deviceId?: string; name?: string; isPrimary?: boolean; addedBy?: string }) {
    return this.authService.registerWhitelistFromToken(body.authToken, body.deviceId ?? '', {
      name: body.name, isPrimary: body.isPrimary, addedBy: body.addedBy,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(200)
  logout(@Request() req) {
    return this.authService.logout(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  getMe(@Request() req) {
    return this.authService.getMe(req.user.userId);
  }
}