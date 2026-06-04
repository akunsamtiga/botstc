import {
  Body, Controller, Get, Post,
  Request, UseGuards, HttpCode,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    // Teruskan proxyUrl dari request body ke service.
    // Jika frontend tidak kirim proxyUrl, nilainya undefined → service fallback ke LOGIN_PROXY global.
    return this.authService.login(dto.email, dto.password, dto.proxyUrl);
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