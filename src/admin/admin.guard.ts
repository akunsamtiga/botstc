import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

/**
 * AdminGuard — pakai SETELAH JwtAuthGuard (yang mengisi req.user.email).
 * Memverifikasi email user (dari JWT, bukan input client) ada di admin_users & aktif.
 * Query memakai service_role → bypass RLS, jadi pengecekan tetap jalan walau
 * tabel admin_users tidak lagi dapat dibaca anon.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly supabase: SupabaseService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const email: string | undefined = req.user?.email?.toLowerCase?.().trim?.();
    if (!email) throw new ForbiddenException('Autentikasi diperlukan');

    const { data } = await this.supabase.client
      .from('admin_users')
      .select('email')
      .eq('email', email)
      .eq('is_active', true)
      .maybeSingle();

    if (!data) throw new ForbiddenException('Akses ditolak: bukan admin');
    return true;
  }
}

/**
 * SuperAdminGuard — pakai SETELAH JwtAuthGuard.
 * Memverifikasi email user ada di super_admins.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(private readonly supabase: SupabaseService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const email: string | undefined = req.user?.email?.toLowerCase?.().trim?.();
    if (!email) throw new ForbiddenException('Autentikasi diperlukan');

    const { data } = await this.supabase.client
      .from('super_admins')
      .select('email')
      .eq('email', email)
      .maybeSingle();

    if (!data) throw new ForbiddenException('Akses ditolak: bukan super admin');
    return true;
  }
}
