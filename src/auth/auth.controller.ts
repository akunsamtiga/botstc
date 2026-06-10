import {
  Body, Controller, Get, Post,
  Request, UseGuards, HttpCode,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
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
   * Registrasi akun Stockity langsung (inline, tanpa webview).
   * Proxy ke Stockity sign_up + simpan session + whitelist + terbitkan JWT.
   * Throttle ketat: maksimal 5 pendaftaran / menit / IP.
   */
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('register')
  @HttpCode(200)
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto.email, dto.password, dto.currency ?? 'IDR');
  }

  /**
   * Login Google: tukar authtoken Stockity (dari in-app WebView OAuth) → sesi+JWT.
   */
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('session-from-token')
  @HttpCode(200)
  sessionFromToken(@Body() body: { authToken: string; deviceId?: string }) {
    return this.authService.sessionFromToken(body.authToken, body.deviceId);
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