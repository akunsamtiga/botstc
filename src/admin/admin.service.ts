import { Injectable, Logger, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';
import { MailService } from '../mail/mail.service';

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
  constructor(
    private readonly supabase: SupabaseService,
    private readonly mail: MailService,
  ) {}

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
    const admins = data ?? [];
    // Gabungkan masa aktif (expires_at) + status whitelist per admin
    const emails = admins.map((a: any) => (a.email || '').toLowerCase());
    if (emails.length) {
      const { data: wl } = await this.db.from('whitelist_users')
        .select('email, expires_at, is_active').in('email', emails);
      const map = new Map((wl ?? []).map((w: any) => [(w.email || '').toLowerCase(), w]));
      return admins.map((a: any) => {
        const w = map.get((a.email || '').toLowerCase());
        return { ...a, expires_at: w?.expires_at ?? null, whitelist_active: w?.is_active ?? null };
      });
    }
    return admins;
  }

  /**
   * Pastikan email ada di whitelist & aktif — supaya admin bisa login
   * (whitelist guard tidak memblokirnya). Idempoten.
   */
  private async ensureWhitelisted(email: string, name?: string): Promise<void> {
    const e = email.toLowerCase().trim();
    const { data } = await this.db.from('whitelist_users').select('id').eq('email', e).maybeSingle();
    if (data) {
      await this.db.from('whitelist_users').update({ is_active: true }).eq('email', e);
    } else {
      const { error } = await this.db.from('whitelist_users').insert({
        email: e, name: name || e.split('@')[0], is_active: true, is_primary: false,
        added_at: new Date().toISOString(), added_by: 'admin-auto',
      });
      if (error) throw new BadRequestException('Gagal whitelist admin baru: ' + error.message);
    }
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
    // ✅ Admin baru otomatis masuk whitelist (aktif) agar bisa login
    await this.ensureWhitelisted(e, name);
    // Default masa aktif: admin biasa = 7 hari; super-admin = permanen
    if ((role ?? 'admin') !== 'super_admin') {
      await this.setUserPeriod(e, 7);
    }
  }

  // ── Reaktivasi & standing admin ─────────────────────────────────────────────────
  private readonly PRICE_PER_USER = 0.5;

  /** Standing admin saat ini: masa aktif, jumlah user di-add, biaya reaktivasi, request pending. */
  async getMyStanding(email: string): Promise<{
    expires_at: string | null; is_active: boolean; isSuperAdmin: boolean;
    userCount: number; pricePerUser: number; amountUsd: number;
    pendingRequest: any | null;
  }> {
    const e = email.toLowerCase().trim();
    const { isSuperAdmin } = await this.getMe(e);
    const [{ data: w }, cntRes, { data: pending }] = await Promise.all([
      this.db.from('whitelist_users').select('expires_at, is_active').eq('email', e).maybeSingle(),
      this.db.from('whitelist_users').select('*', { count: 'exact', head: true }).eq('added_by', e),
      this.db.from('reactivation_requests').select('*').eq('admin_email', e).eq('status', 'pending').order('id', { ascending: false }).maybeSingle(),
    ]);
    const userCount = cntRes.count ?? 0;
    return {
      expires_at: w?.expires_at ?? null,
      is_active: w?.is_active ?? true,
      isSuperAdmin,
      userCount,
      pricePerUser: this.PRICE_PER_USER,
      amountUsd: +(userCount * this.PRICE_PER_USER).toFixed(2),
      pendingRequest: pending ?? null,
    };
  }

  /** Admin biasa mengajukan reaktivasi (paket 7/14/30 hari). Pembayaran via DM manual. */
  async requestReactivation(email: string, days: number): Promise<any> {
    const e = email.toLowerCase().trim();
    if (![7, 14, 30].includes(days)) throw new BadRequestException('Paket tidak valid (7/14/30 hari)');
    const { data: adm } = await this.db.from('admin_users').select('name, role').eq('email', e).maybeSingle();
    if (!adm) throw new ForbiddenException('Bukan admin');
    if (adm.role === 'super_admin') throw new BadRequestException('Super-admin tidak perlu reaktivasi');

    const { count } = await this.db.from('whitelist_users').select('*', { count: 'exact', head: true }).eq('added_by', e);
    const userCount = count ?? 0;
    const amount = +(userCount * this.PRICE_PER_USER).toFixed(2);

    // Satu request pending aktif per admin — hapus yang lama
    await this.db.from('reactivation_requests').delete().eq('admin_email', e).eq('status', 'pending');
    const { data, error } = await this.db.from('reactivation_requests').insert({
      admin_email: e, admin_name: adm.name || e.split('@')[0],
      days, user_count: userCount, amount_usd: amount, status: 'pending',
    }).select().single();
    if (error) throw new BadRequestException('Gagal mengajukan reaktivasi: ' + error.message);
    return data;
  }

  /** Super-admin: daftar permintaan reaktivasi (terbaru dulu). */
  async listReactivationRequests(): Promise<any[]> {
    const { data, error } = await this.db.from('reactivation_requests')
      .select('*').order('id', { ascending: false }).limit(100);
    if (error) throw new BadRequestException('Gagal memuat permintaan: ' + error.message);
    return data ?? [];
  }

  /** Super-admin ACCEPT (setelah pembayaran via DM) → reaktivasi admin sesuai paket. */
  async approveReactivation(id: number, resolver: string): Promise<{ admin_email: string; days: number }> {
    const { data: r } = await this.db.from('reactivation_requests').select('*').eq('id', id).maybeSingle();
    if (!r) throw new NotFoundException('Permintaan tidak ditemukan');
    if (r.status !== 'pending') throw new BadRequestException('Permintaan sudah diproses');
    await this.setUserPeriod(r.admin_email, r.days);  // reaktivasi + perpanjang
    const { error } = await this.db.from('reactivation_requests')
      .update({ status: 'approved', resolved_at: new Date().toISOString(), resolved_by: resolver.toLowerCase().trim() })
      .eq('id', id);
    if (error) throw new BadRequestException('Gagal approve: ' + error.message);
    return { admin_email: r.admin_email, days: r.days };
  }

  async rejectReactivation(id: number, resolver: string): Promise<void> {
    const { data: r } = await this.db.from('reactivation_requests').select('status').eq('id', id).maybeSingle();
    if (!r) throw new NotFoundException('Permintaan tidak ditemukan');
    if (r.status !== 'pending') throw new BadRequestException('Permintaan sudah diproses');
    const { error } = await this.db.from('reactivation_requests')
      .update({ status: 'rejected', resolved_at: new Date().toISOString(), resolved_by: resolver.toLowerCase().trim() })
      .eq('id', id);
    if (error) throw new BadRequestException('Gagal reject: ' + error.message);
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

  // ── Broadcast email (super-admin) ──────────────────────────────────────────────
  /**
   * Kirim email ke satu user atau SEMUA user whitelist via SMTP (MailService).
   * target='one' → kirim ke `email`. target='all' → kirim ke semua whitelist_users.
   */
  async sendBroadcastEmail(params: {
    target: 'one' | 'all' | 'custom';
    email?: string;
    emails?: string[];
    subject: string;
    message: string;
    html?: boolean;
  }): Promise<{ sent: number; failed: number; total: number; errors: string[] }> {
    const subject = (params.subject ?? '').trim();
    const message = (params.message ?? '').trim();
    if (!subject) throw new BadRequestException('Subjek email wajib diisi');
    if (!message) throw new BadRequestException('Isi pesan wajib diisi');
    if (!this.mail.isConfigured()) {
      throw new BadRequestException(
        'SMTP belum dikonfigurasi di server. Set SMTP_HOST/SMTP_USER/SMTP_PASS di .env.',
      );
    }

    let recipients: string[] = [];
    if (params.target === 'all') {
      const { data, error } = await this.db.from('whitelist_users').select('email');
      if (error) throw new BadRequestException('Gagal mengambil daftar user: ' + error.message);
      recipients = [
        ...new Set(
          (data ?? [])
            .map((r: any) => String(r.email ?? '').toLowerCase().trim())
            .filter((e: string) => e.includes('@')),
        ),
      ];
    } else if (params.target === 'custom') {
      // Email bebas (boleh di luar whitelist), bisa banyak sekaligus.
      recipients = [
        ...new Set(
          (params.emails ?? [])
            .map((e) => String(e ?? '').toLowerCase().trim())
            .filter((e) => e.includes('@')),
        ),
      ];
      if (recipients.length === 0) throw new BadRequestException('Tidak ada email custom yang valid');
    } else {
      const e = (params.email ?? '').toLowerCase().trim();
      if (!e.includes('@')) throw new BadRequestException('Email tujuan tidak valid');
      recipients = [e];
    }

    if (recipients.length === 0) throw new BadRequestException('Tidak ada penerima');

    const isHtml = params.html === true;
    const html = this.buildEmailHtml(subject, message, isHtml);
    // Versi teks (fallback klien non-HTML): kalau mode HTML, strip tag kasar.
    const text = isHtml
      ? message.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      : message;
    const res = await this.mail.sendBulk(recipients, subject, html, text);
    this.logger.log(
      `Broadcast email "${subject}" → sent=${res.sent} failed=${res.failed} total=${recipients.length}`,
    );
    return { ...res, total: recipients.length };
  }

  /**
   * Bungkus pesan dalam template HTML ber-brand STC.
   * isHtml=false → escape + nl2br (pesan teks biasa).
   * isHtml=true  → pesan dipakai sebagai HTML mentah (super-admin tepercaya).
   */
  private buildEmailHtml(subject: string, message: string, isHtml = false): string {
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const body = isHtml ? message : esc(message).replace(/\n/g, '<br>');
    return `<!doctype html><html><body style="margin:0;background:#f2f2f7;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.06);">
    <div style="background:#0a1e0f;padding:20px 24px;">
      <span style="color:#5cc763;font-size:20px;font-weight:700;letter-spacing:-0.5px;">STC AutoTrade</span>
    </div>
    <div style="padding:24px;">
      <h1 style="margin:0 0 14px;font-size:18px;color:#1c1c1e;">${esc(subject)}</h1>
      <div style="font-size:14px;color:#3a3a3c;line-height:1.6;">${body}</div>
    </div>
    <div style="padding:16px 24px;border-top:1px solid #eee;font-size:12px;color:#8e8e93;">
      Email ini dikirim oleh tim STC AutoTrade. Mohon jangan balas email ini.
    </div>
  </div>
</body></html>`;
  }

  // ── Admin chat — Direct Message (1-on-1) ───────────────────────────────────────
  private convoKey(a: string, b: string): string {
    return [a.toLowerCase().trim(), b.toLowerCase().trim()].sort().join('|');
  }

  /**
   * Daftar kontak yang boleh diajak chat:
   * - super-admin → SEMUA admin (kecuali dirinya).
   * - admin biasa → hanya super-admin.
   */
  async listChatContacts(requester: RequesterCtx): Promise<any[]> {
    const me = requester.email.toLowerCase().trim();
    if (requester.isSuper) {
      const { data, error } = await this.db.from('admin_users')
        .select('email, name, role, is_active').neq('email', me).order('name', { ascending: true });
      if (error) throw new BadRequestException('Gagal memuat kontak: ' + error.message);
      return data ?? [];
    }
    // admin biasa → super-admin saja (ambil nama dari admin_users role super_admin)
    const { data, error } = await this.db.from('admin_users')
      .select('email, name, role, is_active').eq('role', 'super_admin').neq('email', me).order('name', { ascending: true });
    if (error) throw new BadRequestException('Gagal memuat kontak: ' + error.message);
    return data ?? [];
  }

  /** Validasi: apakah `requester` boleh chat dengan `target`? */
  private async assertCanChat(requester: RequesterCtx, target: string): Promise<void> {
    const t = target.toLowerCase().trim();
    if (!t || t === requester.email.toLowerCase().trim()) throw new BadRequestException('Tujuan tidak valid');
    if (requester.isSuper) {
      const { data } = await this.db.from('admin_users').select('email').eq('email', t).maybeSingle();
      if (!data) throw new ForbiddenException('Tujuan bukan admin');
    } else {
      const { data } = await this.db.from('super_admins').select('email').eq('email', t).maybeSingle();
      if (!data) throw new ForbiddenException('Admin biasa hanya bisa chat super-admin');
    }
  }

  /** Pesan dalam satu percakapan (me ↔ withEmail). afterId>0 = incremental (polling). */
  async getConversation(me: string, withEmail: string, afterId = 0, limit = 50): Promise<any[]> {
    const key = this.convoKey(me, withEmail);
    const lim = Math.min(Math.max(limit, 1), 100);
    if (afterId > 0) {
      const { data, error } = await this.db.from('admin_chat').select('*')
        .eq('conversation_key', key).gt('id', afterId).order('id', { ascending: true }).limit(lim);
      if (error) throw new BadRequestException('Gagal memuat chat: ' + error.message);
      return data ?? [];
    }
    const { data, error } = await this.db.from('admin_chat').select('*')
      .eq('conversation_key', key).order('id', { ascending: false }).limit(lim);
    if (error) throw new BadRequestException('Gagal memuat chat: ' + error.message);
    return (data ?? []).reverse();
  }

  async sendDm(requester: RequesterCtx, to: string, content: string): Promise<any> {
    const text = (content ?? '').trim();
    if (!text) throw new BadRequestException('Pesan kosong');
    if (text.length > 2000) throw new BadRequestException('Pesan terlalu panjang (maks 2000 karakter)');
    await this.assertCanChat(requester, to);

    const me = requester.email.toLowerCase().trim();
    const recipient = to.toLowerCase().trim();
    const { data: adm } = await this.db.from('admin_users').select('name').eq('email', me).maybeSingle();
    const name = adm?.name || me.split('@')[0];

    const { data, error } = await this.db.from('admin_chat').insert({
      sender_email: me, sender_name: name, recipient_email: recipient,
      conversation_key: this.convoKey(me, recipient), content: text,
    }).select().single();
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

  // ── Masa aktif (expiry) ─────────────────────────────────────────────────────────
  /**
   * Super-admin set masa aktif user (dalam hari). days<=0 → permanen (hapus expiry).
   * Sekaligus mengaktifkan kembali (is_active=true).
   */
  async setUserPeriod(email: string, days: number): Promise<{ email: string; expires_at: string | null }> {
    const e = email.toLowerCase().trim();
    if (!e) throw new BadRequestException('Email kosong');
    const expires_at = days && days > 0
      ? new Date(Date.now() + days * 86_400_000).toISOString()
      : null;

    const { data: exist } = await this.db.from('whitelist_users').select('id').eq('email', e).maybeSingle();
    if (!exist) {
      const { error } = await this.db.from('whitelist_users').insert({
        email: e, is_active: true, is_primary: false,
        added_at: new Date().toISOString(), added_by: 'admin-auto', expires_at,
      });
      if (error) throw new BadRequestException('Gagal set masa aktif: ' + error.message);
    } else {
      const { error } = await this.db.from('whitelist_users')
        .update({ expires_at, is_active: true }).eq('email', e);
      if (error) throw new BadRequestException('Gagal set masa aktif: ' + error.message);
    }
    return { email: e, expires_at };
  }

  /** Nonaktifkan akun yang masa aktifnya sudah lewat (expires_at < now & masih aktif). */
  async deactivateExpired(): Promise<number> {
    const { data, error } = await this.db.from('whitelist_users')
      .update({ is_active: false })
      .lt('expires_at', new Date().toISOString())
      .eq('is_active', true)
      .select('email');
    if (error) { this.logger.warn('deactivateExpired gagal: ' + error.message); return 0; }
    const n = (data ?? []).length;
    if (n) this.logger.log(`⏳ ${n} akun nonaktif (masa aktif habis): ${(data ?? []).map((r: any) => r.email).join(', ')}`);
    return n;
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async cronDeactivateExpired() {
    await this.deactivateExpired();
  }
}
