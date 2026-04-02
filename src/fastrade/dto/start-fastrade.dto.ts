import {
  IsBoolean, IsNumber, IsObject, IsOptional,
  IsString, Min, Max, IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

export class FastradeAssetDto {
  @IsString() ric: string;
  @IsString() name: string;
  @IsOptional() @IsNumber() profitRate?: number;
  @IsOptional() @IsString() typeName?: string;
  @IsOptional() @IsString() iconUrl?: string | null;
}

export class FastradeMartingaleDto {
  @IsBoolean() isEnabled: boolean;
  @IsNumber() @Min(1) @Max(10) maxSteps: number;
  @IsNumber() @Min(1) baseAmount: number;
  @IsNumber() @Min(0) multiplierValue: number;
  @IsIn(['FIXED', 'PERCENTAGE']) multiplierType: 'FIXED' | 'PERCENTAGE';
}

export class StartFastradeDto {
  @IsIn(['FTT', 'CTC']) mode: 'FTT' | 'CTC';

  @IsObject() @Type(() => FastradeAssetDto)
  asset: FastradeAssetDto;

  @IsObject() @Type(() => FastradeMartingaleDto)
  martingale: FastradeMartingaleDto;

  @IsBoolean() isDemoAccount: boolean;
  @IsString() currency: string;
  @IsString() currencyIso: string;

  @IsOptional() @IsNumber() @Min(0) stopLoss?: number;
  @IsOptional() @IsNumber() @Min(0) stopProfit?: number;
}