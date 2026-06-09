import { Injectable, Logger, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

/** Konteks pemanggil untuk enforcement kepemilikan. */
export interface RequesterCtx { email: string; isSuper: boolean; }

/**
 * AdminService — semua operasi privileged (whitelist/admin/super-admin/config)
 * dijalankan di server dengan service_role. Menggantikan penulisan langsung
 * dari browser (yang dulu pakai anon/service_role key — celah C2).
 *
 * Fungsi return data mentah/ringkas; frontend (supabaseRepository) yang
 * menormalkan ke bentuk UI, sehingga signature di frontend tidak berubah.
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  constructor(private readonly supabase: SupabaseService) {}

  private get db() { return this.supabase.client; }

  // ── Role checks ────────────────────────────────────────────────────────────
  async getMe(email: string): Promise<{ isAdmin: boolean; isSuperAdmin: boolean }> {
    const e = email.toLowerCase().trim();
    const [{ data: adm }, { data: sup }] = await Promise.all([
      this.db.from('admin_users').select('email').eq('email', e).eq('is_active', true).maybeSingle(),
      this.db.from('super_admins').select('email').eq('email', e).maybeSingle(),
    ]);
    return { isAdmin: !!adm || !!sup, isSuperAdmin: !!sup };
  }

  // ── Whitelist ───────────────────────────────────────────────────────────────
  async listWhitelist(requesterEmail: string, isSuper: boolean): Promise<any[]> {
    let q = this.db.from('whitelist_users').select('*')
      .eq('is_primary', false)
      .order('added_at', { ascending: false });
    if (!isSuper && requesterEmail) q = q.eq('added_by', requesterEmail);
    const { data, error } = await q;
    if (error) throw new BadRequestException('Gagal memuat whitelist: ' + error.message);
    return data ?? [];
  }

  async addWhitelist(
    payload: { email: string; name?: string; userId?: string; deviceId?: string; isPrimary?: boolean },
    addedBy: string,
  ): Promise<void> {
    const { error } = await this.db.from('whitelist_users').insert({
      email:      payload.email.toLowerCase().trim(),
      is_active:  true,
      is_primary: payload.isPrimary ?? false,
      added_at:   new Date().toISOString(),
      added_by:   addedBy ?? 'system',
      name:       payload.name      ?? null,
      user_id:    payload.userId    ?? null,
      device_id:  payload.deviceId  ?? null,
    });
    if (error) throw new BadRequestException('Gagal menambahkan ke whitelist: ' + error.message);
  }

  /**
   * Enforcement kepemilikan: admin biasa hanya boleh mengelola user yang
   * dia tambahkan sendiri (added_by === email-nya). Super-admin bypass.
   * `byId=true` untuk lookup berdasarkan kolom id (dipakai delete fallback).
   */
  private async assertOwner(target: string, requester?: RequesterCtx, byId = false): Promise<void> {
    if (!requester || requester.isSuper) return; // super-admin / konteks internal → bebas
    const col = byId ? 'id' : 'email';
    const val = byId ? target : target.toLowerCase().trim();
    const { data, error } = await this.db
      .from('whitelist_users').select('added_by').eq(col, val).maybeSingle();
    if (error) throw new BadRequestException('Gagal memeriksa kepemilikan: ' + error.message);
    if (!data) throw new NotFoundException('User tidak ditemukan');
    if ((data.added_by ?? '').toLowerCase().trim() !== requester.email.toLowerCase().trim()) {
      throw new ForbiddenException('Anda hanya bisa mengelola user yang Anda tambahkan sendiri');
    }
  }

  async updateWhitelist(oldEmail: string, updates: {
    email?: string; name?: string; userId?: string; deviceId?: string;
    isActive?: boolean; lastLogin?: number | null;
  }, requester?: RequesterCtx): Promise<void> {
    await this.assertOwner(oldEmail, requester);
    const data: Record<string, unknown> = {};
    if (updates.name     !== undefined) data.name      = updates.name;
    if (updates.userId   !== undefined) data.user_id   = updates.userId;
    if (updates.deviceId !== undefined) data.device_id = updates.deviceId;
    if (updates.email    !== undefined) data.email     = updates.email.toLowerCase().trim();
    if (updates.isActive !== undefined) data.is_active = updates.isActive;
    if (updates.lastLogin !== undefined) {
      data.last_login = updates.lastLogin === 0 || updates.lastLogin === null
        ? null : new Date(updates.lastLogin).toISOString();
    }
    const { error } = await this.db.from('whitelist_users')
      .update(data).eq('email', oldEmail.toLowerCase().trim());
    if (error) throw new BadRequestException('Gagal mengupdate whitelist: ' + error.message);
  }

  async toggleWhitelist(email: string, isActive: boolean, requester?: RequesterCtx): Promise<void> {
    await this.assertOwner(email, requester);
    const { error } = await this.db.from('whitelist_users')
      .update({ is_active: isActive }).eq('email', email.toLowerCase().trim());
    if (error) throw new BadRequestException('Gagal mengupdate status: ' + error.message);
  }

  async deleteWhitelist(emailOrId: string, requester?: RequesterCtx): Promise<void> {
    const normalized = emailOrId.toLowerCase().trim();
    // Tentukan dulu apakah target ada by email atau by id, lalu cek kepemilikan.
    const { data: byEmail } = await this.db
      .from('whitelist_users').select('id').eq('email', normalized).maybeSingle();
    if (byEmail) {
      await this.assertOwner(normalized, requester);
      const { error } = await this.db.from('whitelist_users').delete().eq('email', normalized);
      if (error) throw new BadRequestException('Gagal menghapus whitelist: ' + error.message);
      return;
    }
    // Fallback by id
    await this.assertOwner(emailOrId, requester, true);
    const { error: idErr } = await this.db.from('whitelist_users').delete().eq('id', emailOrId);
    if (idErr) throw new BadRequestException('Gagal menghapus whitelist: ' + idErr.message);
  }

  async importWhitelist(rows: any[], addedBy: string): Promise<{ success: number; skipped: number }> {
    if (!Array.isArray(rows) || rows.length === 0) return { success: 0, skipped: 0 };
    let success = 0, skipped = 0;
    const mapped = rows.map((u) => ({
      email:      ((u.email ?? '') as string).toLowerCase().trim(),
      is_active:  u.isActive ?? u.is_active ?? true,
      added_at:   u.createdAt ? new Date(u.createdAt).toISOString() : new Date().toISOString(),
      added_by:   addedBy ?? u.addedBy ?? u.added_by ?? 'system',
      name:       u.name ?? null,
      user_id:    u.userId ?? u.user_id ?? null,
      device_id:  u.deviceId ?? u.device_id ?? null,
      last_login: u.lastLogin ? new Date(u.lastLogin).toISOString() : null,
    })).filter((r) => r.email);
    for (const row of mapped) {
      const { error } = await this.db.from('whitelist_users').insert(row);
      if (error) skipped++; else success++;
    }
    return { success, skipped };
  }

  async stats(requesterEmail: string, isSuper: boolean): Promise<{
    total: number; active: number; inactive: number; recent: number; recentAdded: number;
  }> {
    const threshold24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const base = () => {
      let q = this.db.from('whitelist_users').select('*', { count: 'exact', head: true }).eq('is_primary', false);
      if (!isSuper && requesterEmail) q = q.eq('added_by', requesterEmail);
      return q;
    };
    const [t, a, i, r, ra] = await Promise.all([
      base(),
      base().eq('is_active', true),
      base().eq('is_active', false),
      base().gte('last_login', threshold24h),
      base().eq('added_by', 'system').gte('added_at', threshold24h),
    ]);
    return {
      total: t.count ?? 0, active: a.count ?? 0, inactive: i.count ?? 0,
      recent: r.count ?? 0, recentAdded: ra.count ?? 0,
    };
  }

  /** Update last_login — dipanggil dari alur login backend (service_role). */
  async touchLastLogin(email: string): Promise<void> {
    const { error } = await this.db.from('whitelist_users')
      .update({ last_login: new Date().toISOString() })
      .eq('email', email.toLowerCase().trim());
    if (error) this.logger.warn(`touchLastLogin gagal untuk ${email}: ${error.message}`);
  }

  /** Self-registration: user yang sudah login (JWT) menambahkan DIRINYA sendiri. */
  async selfRegister(
    email: string, userId: string,
    payload: { name?: string; deviceId?: string; isPrimary?: boolean; addedBy?: string },
  ): Promise<void> {
    const e = email.toLowerCase().trim();
    const { data: existing } = await this.db.from('whitelist_users')
      .select('email').eq('email', e).maybeSingle();
    if (existing) return; // sudah ada — idempoten
    const { error } = await this.db.from('whitelist_users').insert({
      email:      e,
      is_active:  true,
      is_primary: payload.isPrimary ?? false,
      added_at:   new Date().toISOString(),
      added_by:   payload.addedBy ?? 'system',
      name:       payload.name ?? null,
      user_id:    userId ?? null,
      device_id:  payload.deviceId ?? userId ?? null,
      last_login: new Date().toISOString(),
    });
    if (error) throw new BadRequestException('Gagal mendaftarkan whitelist: ' + error.message);
  }

  // ── Admin users ──────────────────────────────────────────────────────────────
  async listAdmins(): Promise<any[]> {
    const { data, error } = await this.db.from('admin_users').select('*').order('created_at', { ascending: false });
    if (error) throw new BadRequestException('Gagal memuat admin: ' + error.message);
    return data ?? [];
  }

  async addAdmin(email: string, name?: string, role?: string): Promise<void> {
    const e = email.toLowerCase().trim();
    const { error } = await this.db.from('admin_users').insert({
      email: e, name: name ?? e.split('@')[0], role: role ?? 'admin',
      is_active: true, created_at: new Date().toISOString(),
    });
    if (error) throw new BadRequestException('Gagal menambahkan admin: ' + error.message);
    if (role === 'super_admin') {
      const { error: saErr } = await this.db.from('super_admins')
        .insert({ email: e, created_at: new Date().toISOString() });
      if (saErr && !saErr.message.includes('duplicate')) {
        throw new BadRequestException('Gagal sync super_admins: ' + saErr.message);
      }
    }
  }

  async updateAdmin(id: string, updates: { name?: string; role?: 'admin' | 'super_admin'; is_active?: boolean }): Promise<void> {
    const { data: existing } = await this.db.from('admin_users').select('email, role').eq('id', id).maybeSingle();
    const { error } = await this.db.from('admin_users').update(updates).eq('id', id);
    if (error) throw new BadRequestException('Gagal mengupdate admin: ' + error.message);
    if (existing?.email && updates.role !== undefined) {
      const email = existing.email;
      if (updates.role === 'super_admin') {
        const { error: saErr } = await this.db.from('super_admins').insert({ email, created_at: new Date().toISOString() });
        if (saErr && !saErr.message.includes('duplicate')) this.logger.warn('sync super_admins: ' + saErr.message);
      } else if (existing.role === 'super_admin' && updates.role === 'admin') {
        await this.db.from('super_admins').delete().eq('email', email);
      }
    }
  }

  async removeAdmin(emailOrId: string): Promise<void> {
    const normalized = emailOrId.toLowerCase().trim();
    const { data: existing } = await this.db.from('admin_users')
      .select('email').or(`email.eq.${normalized},id.eq.${emailOrId}`).maybeSingle();
    const { error: emailErr } = await this.db.from('admin_users').delete().eq('email', normalized);
    if (emailErr) {
      const { error: idErr } = await this.db.from('admin_users').delete().eq('id', emailOrId);
      if (idErr) throw new BadRequestException('Gagal menghapus admin: ' + idErr.message);
    }
    if (existing?.email) await this.db.from('super_admins').delete().eq('email', existing.email);
  }

  // ── Super admins ─────────────────────────────────────────────────────────────
  async listSuperAdmins(): Promise<any[]> {
    const { data, error } = await this.db.from('super_admins').select('*').order('created_at', { ascending: false });
    if (error) throw new BadRequestException('Gagal memuat super admin: ' + error.message);
    return data ?? [];
  }

  async addSuperAdmin(email: string): Promise<void> {
    const { error } = await this.db.from('super_admins')
      .insert({ email: email.toLowerCase().trim(), created_at: new Date().toISOString() });
    if (error) throw new BadRequestException('Gagal menambahkan super admin: ' + error.message);
  }

  async deleteSuperAdmin(email: string): Promise<void> {
    const { error } = await this.db.from('super_admins').delete().eq('email', email.toLowerCase().trim());
    if (error) throw new BadRequestException('Gagal menghapus super admin: ' + error.message);
  }

  // ── Config (app_config) ───────────────────────────────────────────────────────
  async upsertConfig(key: string, value: unknown): Promise<void> {
    const { error } = await this.db.from('app_config').upsert(
      { key, value: typeof value === 'string' ? value : JSON.stringify(value), updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
    if (error) throw new BadRequestException('Gagal mengupdate config: ' + error.message);
  }

  // ── Admin chat (antar admin/super-admin) ───────────────────────────────────────
  /**
   * Daftar pesan. afterId>0 → pesan baru setelah id itu (untuk polling, urut naik).
   * afterId=0 → ambil `limit` pesan terbaru (lalu dibalik jadi urut naik).
   */
  async listChat(afterId = 0, limit = 50): Promise<any[]> {
    const lim = Math.min(Math.max(limit, 1), 100);
    if (afterId > 0) {
      const { data, error } = await this.db
        .from('admin_chat').select('*')
        .gt('id', afterId).order('id', { ascending: true }).limit(lim);
      if (error) throw new BadRequestException('Gagal memuat chat: ' + error.message);
      return data ?? [];
    }
    const { data, error } = await this.db
      .from('admin_chat').select('*')
      .order('id', { ascending: false }).limit(lim);
    if (error) throw new BadRequestException('Gagal memuat chat: ' + error.message);
    return (data ?? []).reverse();
  }

  async sendChat(email: string, content: string): Promise<any> {
    const text = (content ?? '').trim();
    if (!text) throw new BadRequestException('Pesan kosong');
    if (text.length > 2000) throw new BadRequestException('Pesan terlalu panjang (maks 2000 karakter)');

    const e = email.toLowerCase().trim();
    const { data: adm } = await this.db.from('admin_users').select('name').eq('email', e).maybeSingle();
    const name = adm?.name || e.split('@')[0];

    const { data, error } = await this.db.from('admin_chat')
      .insert({ sender_email: e, sender_name: name, content: text })
      .select().single();
    if (error) throw new BadRequestException('Gagal mengirim pesan: ' + error.message);
    return data;
  }

  /** Hapus pesan — hanya pengirim sendiri atau super-admin. */
  async deleteChat(id: number, requester: RequesterCtx): Promise<void> {
    if (!Number.isFinite(id)) throw new BadRequestException('ID tidak valid');
    if (!requester.isSuper) {
      const { data } = await this.db.from('admin_chat').select('sender_email').eq('id', id).maybeSingle();
      if (!data) throw new NotFoundException('Pesan tidak ditemukan');
      if ((data.sender_email ?? '').toLowerCase().trim() !== requester.email.toLowerCase().trim()) {
        throw new ForbiddenException('Hanya bisa menghapus pesan sendiri');
      }
    }
    const { error } = await this.db.from('admin_chat').delete().eq('id', id);
    if (error) throw new BadRequestException('Gagal menghapus pesan: ' + error.message);
  }
}
