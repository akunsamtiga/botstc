import { IsOptional, IsArray, IsBoolean, IsNumber, IsString } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { OrderTrackingStatus } from '../types';

/**
 * DTO untuk filter query tracking order
 */
export class OrderTrackingFilterDto {
  /**
   * Filter berdasarkan status (bisa multiple, dipisah dengan koma)
   * Contoh: status=PENDING,MONITORING
   */
  @IsOptional()
  @IsString()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map((s: string) => s.trim() as OrderTrackingStatus);
    }
    return value;
  })
  status?: OrderTrackingStatus[];

  /**
   * Filter order dari waktu tertentu (timestamp dalam ms)
   */
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  fromTime?: number;

  /**
   * Filter order sampai waktu tertentu (timestamp dalam ms)
   */
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  toTime?: number;

  /**
   * Hanya tampilkan order yang aktif (belum selesai)
   */
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  onlyActive?: boolean;

  /**
   * Limit jumlah order yang ditampilkan
   */
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  limit?: number;
}
