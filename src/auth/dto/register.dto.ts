import { IsEmail, IsString, MinLength, MaxLength, IsOptional, Matches } from 'class-validator';

export class RegisterDto {
  @IsEmail({}, { message: 'Format email tidak valid' })
  @MaxLength(254, { message: 'Email terlalu panjang' })
  email: string;

  @IsString()
  @MinLength(6, { message: 'Password minimal 6 karakter' })
  @MaxLength(128, { message: 'Password terlalu panjang' })
  password: string;

  // Mata uang akun Stockity (default IDR). 3 huruf ISO, mis. IDR, USD, COP.
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{3}$/, { message: 'Kode mata uang tidak valid' })
  currency?: string;
}
