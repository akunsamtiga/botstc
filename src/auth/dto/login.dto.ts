import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail({}, { message: 'Format email tidak valid' })
  email: string;

  @IsString()
  @MinLength(6, { message: 'Password minimal 6 karakter' })
  password: string;

  /**
   * URL proxy opsional untuk user ini.
   * Setiap request ke Stockity (login & semua API call) akan memakai proxy ini
   * sehingga Stockity melihat IP milik user, bukan IP VPS bersama.
   *
   * Format yang didukung:
   *   socks5://user:pass@host:port
   *   socks5h://user:pass@host:port   ← DNS juga via proxy (direkomendasikan)
   *   http://user:pass@host:port
   *
   * Kosongkan jika user tidak menggunakan proxy (fallback ke LOGIN_PROXY global).
   */
  @IsOptional()
  @IsString()
  proxyUrl?: string;
}