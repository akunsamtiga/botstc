import { IsBoolean, IsNumber, IsOptional, Min, Max } from 'class-validator';

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
  trend: string;
  executionTime?: number;
  originalMessage?: string;
}
