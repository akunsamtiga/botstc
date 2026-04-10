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
}