import { Controller, Get, Put, Body, Request, UseGuards } from '@nestjs/common';
import { ProfileService } from './profile.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UpdateCurrencyDto } from './dto/update-currency.dto';

@UseGuards(JwtAuthGuard)
@Controller('profile')
export class ProfileController {
  constructor(private profileService: ProfileService) {}

  @Get()
  getProfile(@Request() req) {
    return this.profileService.getProfile(req.user.userId);
  }

  @Get('balance')
  getBalance(@Request() req) {
    return this.profileService.getBalance(req.user.userId);
  }

  @Get('currencies')
  getCurrencies(@Request() req) {
    return this.profileService.getCurrencies(req.user.userId);
  }

  /**
   * GET /profile/currency-config
   * Backend proxy untuk fetchPlatformCurrencies — bebas CORS.
   * Returns CurrencyConfig lengkap: currencyIso, currencyUnit, minAmount, maxAmount, quickAmounts.
   */
  @Get('currency-config')
  getCurrencyConfig(@Request() req) {
    return this.profileService.getCurrencyConfig(req.user.userId);
  }

  @Get('assets')
  getAssets(@Request() req) {
    return this.profileService.getAssets(req.user.userId);
  }

  @Put('currency')
  updateCurrency(@Request() req, @Body() dto: UpdateCurrencyDto) {
    return this.profileService.updateCurrency(req.user.userId, dto.currencyIso);
  }
}