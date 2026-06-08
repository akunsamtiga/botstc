-- ============================================================
-- ENABLE RLS — TABEL SENSITIF (CRITICAL SECURITY FIX / C1)
-- ============================================================
-- Masalah: tabel berikut TIDAK punya Row Level Security, sehingga
-- `anon key` publik (ter-embed di bundle frontend) bisa membaca/menulis
-- seluruh isinya lewat PostgREST. Tabel `sessions` memuat stockity_token
-- (+ PK/password) → siapa pun bisa mengimpersonasi semua user di Stockity.
--
-- Solusi: ENABLE RLS tanpa policy apa pun untuk tabel backend-only.
-- Efek: role `anon` & `authenticated` ter-DENY total; backend NestJS yang
-- memakai SERVICE_ROLE key tetap bypass RLS (bisa semua operasi).
--
-- AMAN: frontend tidak pernah mengakses tabel-tabel ini secara langsung
-- (sudah diverifikasi — tidak ada `supabase.from('sessions'|'*_configs'|...)`),
-- jadi mengaktifkan RLS di sini TIDAK merusak fitur apa pun.
--
-- Cara pakai: jalankan SEKALI di Supabase SQL Editor, lalu verifikasi
-- dengan query di bagian paling bawah.
-- ============================================================

-- ── Crown jewels: kredensial & token ─────────────────────────
ALTER TABLE sessions               ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions               FORCE ROW LEVEL SECURITY;

-- ── Trading config (per-user) ────────────────────────────────
ALTER TABLE schedule_configs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE aisignal_configs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE indicator_configs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE fastrade_configs       ENABLE ROW LEVEL SECURITY;

-- ── Trading status (per-user) ────────────────────────────────
ALTER TABLE schedule_status        ENABLE ROW LEVEL SECURITY;
ALTER TABLE aisignal_status        ENABLE ROW LEVEL SECURITY;
ALTER TABLE indicator_status       ENABLE ROW LEVEL SECURITY;
ALTER TABLE fastrade_status        ENABLE ROW LEVEL SECURITY;

-- ── Logs & tracking & sinyal ─────────────────────────────────
ALTER TABLE mode_logs              ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_tracking         ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_tracking_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_signals       ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- CATATAN: whitelist_users, admin_users, super_admins, app_config
-- SENGAJA TIDAK diubah di sini — keempatnya sudah punya RLS di
-- supabase-schema.sql. Pengetatannya (memindahkan operasi admin ke
-- backend & mencabut akses baca anon ke admin_users/super_admins)
-- ditangani terpisah di langkah C2 (backend admin module) agar tidak
-- memutus fitur admin yang sedang berjalan.
-- ============================================================

-- ── VERIFIKASI: pastikan semua tabel public ber-RLS ──────────
-- Jalankan setelah ALTER di atas. Semua baris harus relrowsecurity = true.
--
--   SELECT relname AS table_name, relrowsecurity AS rls_enabled
--   FROM pg_class
--   WHERE relkind = 'r'
--     AND relnamespace = 'public'::regnamespace
--   ORDER BY relrowsecurity, relname;
--
-- ── VERIFIKASI: anon TIDAK bisa baca sessions ────────────────
-- Dari Supabase SQL editor "Run as: anon" atau via REST dengan anon key:
--   SELECT * FROM sessions LIMIT 1;   -- harus error/0 baris (RLS deny)
-- ============================================================
