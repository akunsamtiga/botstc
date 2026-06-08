-- ============================================================
-- STC — LOCKDOWN TABEL BACKEND-ONLY (lengkapi C1)
-- ============================================================
-- Ternyata RLS sudah ENABLE, tapi tabel sensitif punya POLICY permisif
-- (USING true) sehingga anon key MASIH bisa membaca sessions (token + PK).
-- Fix sebenarnya: CABUT semua policy di tabel backend-only.
--   RLS enabled + 0 policy  → anon & authenticated DITOLAK total.
--   Backend NestJS pakai service_role → BYPASS RLS → tetap berjalan normal.
--
-- Tabel yang TETAP anon-readable (dibutuhkan frontend) — TIDAK disentuh:
--   whitelist_users, admin_users, super_admins, app_config
-- (pengetatan admin_users/super_admins menyusul di C2)
-- ============================================================

DO $$
DECLARE
  r record;
  keep text[] := ARRAY['whitelist_users','admin_users','super_admins','app_config'];
BEGIN
  FOR r IN
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND NOT (tablename = ANY(keep))
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I;', r.policyname, r.tablename);
    RAISE NOTICE 'Dropped policy "%" on %', r.policyname, r.tablename;
  END LOOP;
END $$;

-- VERIFIKASI — daftar policy yang TERSISA.
-- Hanya boleh muncul untuk: whitelist_users, admin_users, super_admins, app_config.
-- Jika 'sessions' / *_configs / *_status dll MUNCUL di sini = masih bocor.
SELECT tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
