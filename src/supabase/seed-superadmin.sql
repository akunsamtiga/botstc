-- ============================================================
-- Seed: Default Super Admin
-- Email : zack010591@gmail.com
-- UserID: 174220270
-- Jalankan SEKALI di Supabase SQL Editor setelah schema terpasang.
-- ============================================================

-- 1. Masukkan ke whitelist_users agar bisa login ke aplikasi
INSERT INTO whitelist_users (email, name, user_id, is_active, added_at, added_by)
VALUES (
  'zack010591@gmail.com',
  'Super Admin',
  '174220270',
  true,
  NOW(),
  'system'
)
ON CONFLICT (email) DO UPDATE
  SET user_id   = EXCLUDED.user_id,
      name      = EXCLUDED.name,
      is_active = true;

-- 2. Masukkan ke admin_users agar bisa akses panel admin
INSERT INTO admin_users (email, name, role, is_active, created_at)
VALUES (
  'zack010591@gmail.com',
  'Super Admin',
  'super_admin',
  true,
  NOW()
)
ON CONFLICT (email) DO UPDATE
  SET role      = 'super_admin',
      is_active = true;

-- 3. Masukkan ke super_admins agar dapat akses penuh
INSERT INTO super_admins (email, created_at)
VALUES (
  'zack010591@gmail.com',
  NOW()
)
ON CONFLICT (email) DO NOTHING;

-- Verifikasi hasil
SELECT 'whitelist_users' AS tabel, email, name, user_id, is_active FROM whitelist_users WHERE email = 'zack010591@gmail.com'
UNION ALL
SELECT 'admin_users', email, name, role, is_active FROM admin_users WHERE email = 'zack010591@gmail.com'
UNION ALL
SELECT 'super_admins', email, NULL, NULL, NULL FROM super_admins WHERE email = 'zack010591@gmail.com';