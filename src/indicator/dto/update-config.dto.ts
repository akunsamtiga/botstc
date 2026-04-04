import { IsEnum, IsNumber, IsBoolean, IsOptional, Min, Max } from 'class-validator';
import { IndicatorType } from '../types';

export class UpdateIndicatorConfigDto {
  @IsEnum(IndicatorType)
  @IsOptional()
  type?: IndicatorType;

  @IsNumber()
  @IsOptional()
  @Min(2)
  @Max(200)
  period?: number;

  @IsNumber()
  @IsOptional()
  @Min(50)
  @Max(95)
  rsiOverbought?: number;

  @IsNumber()
  @IsOptional()
  @Min(5)
  @Max(50)
  rsiOversold?: number;

  @IsBoolean()
  @IsOptional()
  isEnabled?: boolean;

  @IsNumber()
  @IsOptional()
  @Min(0.001)
  @Max(100)
  sensitivity?: number;

  @IsNumber()
  @IsOptional()
  @Min(1400000)
  amount?: number;
}
