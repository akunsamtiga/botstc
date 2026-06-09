-- ============================================================
-- REAKTIVASI ADMIN + DEFAULT MASA AKTIF 7 HARI
-- Jalankan SEKALI di Supabase SQL Editor.
-- ============================================================

-- ── Tabel permintaan reaktivasi (backend-only) ──────────────
CREATE TABLE IF NOT EXISTS reactivation_requests (
  id           BIGSERIAL PRIMARY KEY,
  admin_email  TEXT        NOT NULL,
  admin_name   TEXT,
  days         INT         NOT NULL,         -- paket: 7 / 14 / 30
  user_count   INT         NOT NULL,         -- jumlah user yang di-add admin saat request
  amount_usd   NUMERIC     NOT NULL,         -- user_count * 0.5
  status       TEXT        NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ,
  resolved_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_reactivation_status ON reactivation_requests (status, id);
ALTER TABLE reactivation_requests ENABLE ROW LEVEL SECURITY;  -- tanpa policy → anon ditolak

-- ── Default masa aktif 7 hari untuk admin biasa yang belum punya expiry ──
-- Super-admin TIDAK kena (permanen). Hanya admin biasa tanpa expires_at.
UPDATE whitelist_users w
SET expires_at = NOW() + INTERVAL '7 days', is_active = TRUE
WHERE w.expires_at IS NULL
  AND LOWER(w.email) IN (SELECT LOWER(email) FROM admin_users WHERE role <> 'super_admin');

-- Verifikasi:
--   SELECT email, expires_at FROM whitelist_users
--   WHERE LOWER(email) IN (SELECT LOWER(email) FROM admin_users WHERE role<>'super_admin');
