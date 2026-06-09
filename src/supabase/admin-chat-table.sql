-- ============================================================
-- ADMIN CHAT — tabel pesan antar admin/super-admin
-- ============================================================
-- Backend-only: RLS aktif TANPA policy → anon/authenticated DITOLAK.
-- Hanya backend (service_role, lewat AdminGuard) yang baca/tulis.
-- Jalankan SEKALI di Supabase SQL Editor.
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_chat (
  id           BIGSERIAL PRIMARY KEY,
  sender_email TEXT        NOT NULL,
  sender_name  TEXT,
  content      TEXT        NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_chat_id ON admin_chat (id);

ALTER TABLE admin_chat ENABLE ROW LEVEL SECURITY;
-- Sengaja TANPA policy: anon ditolak total, backend service_role bypass RLS.

-- Verifikasi:
--   SELECT relrowsecurity FROM pg_class WHERE relname='admin_chat';  -- harus true
