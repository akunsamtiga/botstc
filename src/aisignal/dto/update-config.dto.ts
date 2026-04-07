import { IsBoolean, IsNumber, IsOptional, Min, Max, IsString, IsIn } from 'class-validator';

export class UpdateAISignalConfigDto {
  @IsNumber()
  @IsOptional()
  @Min(1400000)
  baseAmount?: number;

  @IsBoolean()
  @IsOptional()
  martingaleEnabled?: boolean;

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

  @IsBoolean()
  @IsOptional()
  isAlwaysSignal?: boolean;

  @IsBoolean()
  @IsOptional()
  isDemoAccount?: boolean;
}

export class ReceiveSignalDto {
  @IsString()
  @IsIn(['buy', 'sell', 'call', 'put', 'B', 'S', 'b', 's'])
  trend: string;

  @IsNumber()
  @IsOptional()
  executionTime?: number;

  @IsString()
  @IsOptional()
  originalMessage?: string;
}

/**
 * DTO untuk webhook Telegram
 */
export class TelegramWebhookDto {
  @IsString()
  userId: string;

  @IsString()
  @IsIn(['buy', 'sell', 'call', 'put', 'B', 'S', 'b', 's'])
  trend: string;

  @IsNumber()
  @IsOptional()
  executionTime?: number;

  @IsString()
  @IsOptional()
  originalMessage?: string;

  // Optional fields untuk waktu spesifik
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(23)
  hour?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(59)
  minute?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(59)
  second?: number;
}