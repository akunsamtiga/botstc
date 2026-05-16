import { IsBoolean, IsNumber, IsOptional, Min, Max } from 'class-validator';

export class UpdateMomentumConfigDto {
  @IsBoolean()
  @IsOptional()
  candleSabitEnabled?: boolean;

  @IsBoolean()
  @IsOptional()
  dojiTerjepitEnabled?: boolean;

  @IsBoolean()
  @IsOptional()
  dojiPembatalanEnabled?: boolean;

  @IsBoolean()
  @IsOptional()
  bbSarBreakEnabled?: boolean;

  @IsNumber()
  @IsOptional()
  @Min(1)
  @Max(10)
  maxSteps?: number;

  @IsNumber()
  @IsOptional()
  @Min(1.1)
  @Max(15)
  multiplierValue?: number;

  @IsNumber()
  @IsOptional()
  @Min(1400000)
  baseAmount?: number;

  @IsBoolean()
  @IsOptional()
  isAlwaysSignal?: boolean;

  /**
   * Stop Loss: bot otomatis berhenti jika total kerugian sesi
   * mencapai atau melebihi nilai ini (dalam satuan currency, misal IDR).
   * Contoh: 50000000 = Rp 50.000.000
   * Set 0 untuk menonaktifkan.
   */
  @IsNumber()
  @IsOptional()
  @Min(0)
  stopLoss?: number;

  /**
   * Stop Profit: bot otomatis berhenti jika total keuntungan sesi
   * mencapai atau melebihi nilai ini.
   * Set 0 untuk menonaktifkan.
   */
  @IsNumber()
  @IsOptional()
  @Min(0)
  stopProfit?: number;
}