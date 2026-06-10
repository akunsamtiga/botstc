-- ============================================================
-- RECOVERY: pulihkan whitelist_users dari tabel sessions
-- ============================================================
-- Konteks: tabel whitelist_users tidak sengaja terhapus, tetapi tabel
-- `sessions` masih utuh (berisi semua user yang pernah login). Script ini
-- merekonstruksi whitelist dari sessions.
--
-- Cara pakai: jalankan di Supabase SQL Editor (butuh service_role / owner).
-- Aman dijalankan berulang (idempoten) — baris yang sudah ada TIDAK ditimpa.
--
-- Catatan keterbatasan rekonstruksi dari sessions:
--   • `name`       → diturunkan dari bagian sebelum '@' pada email.
--   • `added_by`   → diisi 'recovered-from-sessions' (info asli sudah hilang).
--   • `expires_at` → dibiarkan NULL = PERMANEN (sengaja, agar tidak ada user
--                    yang langsung ter-nonaktif oleh cron masa-aktif).
--   • `is_primary` → default false.
-- Semua ini bisa kamu sesuaikan lagi lewat panel admin setelah pulih.
-- ============================================================

-- ── 0) Lihat kondisi awal (opsional, untuk perbandingan) ───────────────────
SELECT 'whitelist_users (sebelum)' AS label, count(*) FROM whitelist_users
UNION ALL
SELECT 'sessions (email valid)',     count(*) FROM sessions
WHERE email IS NOT NULL AND btrim(email) <> '';

-- ── 1) Backup kondisi whitelist_users saat ini (jaga-jaga) ─────────────────
--     Tabel snapshot; kalau sudah ada dari run sebelumnya, dilewati.
CREATE TABLE IF NOT EXISTS whitelist_users_backup_pre_recovery AS
SELECT * FROM whitelist_users;

-- ── 2) Insert ulang user dari sessions (tanpa menimpa yang sudah ada) ──────
--     DISTINCT ON email → ambil 1 baris paling baru per email (updated_at DESC).
INSERT INTO whitelist_users
  (email, name, user_id, device_id, is_active, added_at, added_by, last_login)
SELECT DISTINCT ON (lower(btrim(s.email)))
  lower(btrim(s.email))               AS email,
  split_part(s.email, '@', 1)         AS name,
  s.user_id,
  s.device_id,
  true                                AS is_active,
  COALESCE(s.updated_at, now())       AS added_at,
  'recovered-from-sessions'           AS added_by,
  s.updated_at                        AS last_login
FROM sessions s
WHERE s.email IS NOT NULL
  AND btrim(s.email) <> ''
-- Opsional: hanya user yang SEDANG login (belum logout) →
--   buang komentar baris di bawah ini.
-- AND s.logged_out_at IS NULL
ORDER BY lower(btrim(s.email)), s.updated_at DESC NULLS LAST
ON CONFLICT (email) DO NOTHING;

-- ── 3) Verifikasi hasil ────────────────────────────────────────────────────
SELECT 'whitelist_users (sesudah)'        AS label, count(*) FROM whitelist_users
UNION ALL
SELECT 'aktif',                            count(*) FROM whitelist_users WHERE is_active
UNION ALL
SELECT 'hasil recovery',                   count(*) FROM whitelist_users
  WHERE added_by = 'recovered-from-sessions';

-- Email di sessions yang TETAP belum masuk whitelist (cek manual bila ada):
SELECT DISTINCT lower(btrim(s.email)) AS missing_email
FROM sessions s
WHERE s.email IS NOT NULL AND btrim(s.email) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM whitelist_users w
    WHERE w.email = lower(btrim(s.email))
  );

-- ============================================================
-- ROLLBACK (kalau hasil tidak diinginkan):
--   Hapus hanya baris hasil recovery:
--     DELETE FROM whitelist_users WHERE added_by = 'recovered-from-sessions';
--   Atau pulihkan total dari snapshot:
--     TRUNCATE whitelist_users;
--     INSERT INTO whitelist_users SELECT * FROM whitelist_users_backup_pre_recovery;
-- ============================================================
