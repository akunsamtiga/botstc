-- ============================================================
-- CHAT DM + MASA AKTIF ADMIN — migrasi
-- Jalankan SEKALI di Supabase SQL Editor.
-- ============================================================

-- ── Chat jadi Direct Message (1-on-1) ───────────────────────
ALTER TABLE admin_chat ADD COLUMN IF NOT EXISTS recipient_email  TEXT;
ALTER TABLE admin_chat ADD COLUMN IF NOT EXISTS conversation_key TEXT;
ALTER TABLE admin_chat ADD COLUMN IF NOT EXISTS read_at          TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_admin_chat_convo ON admin_chat (conversation_key, id);

-- Pesan "room" lama (tanpa recipient) tidak relevan untuk DM — boleh dibersihkan:
DELETE FROM admin_chat WHERE recipient_email IS NULL;

-- ── Masa aktif (expiry) pada whitelist ──────────────────────
-- expires_at NULL = permanen. expires_at < now() = kedaluwarsa → akun dinonaktifkan.
ALTER TABLE whitelist_users ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_whitelist_expires ON whitelist_users (expires_at) WHERE expires_at IS NOT NULL;

-- Verifikasi:
--   SELECT column_name FROM information_schema.columns WHERE table_name='admin_chat';
--   SELECT column_name FROM information_schema.columns WHERE table_name='whitelist_users' AND column_name='expires_at';
