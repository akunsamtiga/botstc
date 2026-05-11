-- ============================================================
-- Supabase Schema for STC AutoTrade — COMPLETE VERSION
-- ✅ FIX Bug 2: Tambah tabel yang hilang:
--    whitelist_users, admin_users, super_admins, app_config
-- Run seluruh file ini di Supabase SQL Editor.
-- Semua statement pakai IF NOT EXISTS — aman dijalankan ulang.
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- ADMIN & AUTH TABLES (sebelumnya tidak ada di schema ini)
-- ============================================================

-- Whitelist users — siapa saja yang boleh login ke aplikasi
CREATE TABLE IF NOT EXISTS whitelist_users (
  id          UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
  email       TEXT        UNIQUE NOT NULL,
  name        TEXT,
  user_id     TEXT,
  device_id   TEXT,
  is_active   BOOLEAN     DEFAULT true,
  added_at    TIMESTAMPTZ DEFAULT NOW(),
  added_by    TEXT        DEFAULT 'system',
  last_login  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_whitelist_email     ON whitelist_users (email);
CREATE INDEX IF NOT EXISTS idx_whitelist_is_active ON whitelist_users (is_active);
CREATE INDEX IF NOT EXISTS idx_whitelist_added_at  ON whitelist_users (added_at DESC);
CREATE INDEX IF NOT EXISTS idx_whitelist_last_login ON whitelist_users (last_login DESC);

-- Admin users — siapa saja yang bisa akses panel admin
CREATE TABLE IF NOT EXISTS admin_users (
  id         UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
  email      TEXT        UNIQUE NOT NULL,
  name       TEXT,
  role       TEXT        DEFAULT 'admin' CHECK (role IN ('admin', 'super_admin')),
  is_active  BOOLEAN     DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_email     ON admin_users (email);
CREATE INDEX IF NOT EXISTS idx_admin_is_active ON admin_users (is_active);

-- Super admins — level akses tertinggi (akses ke semua data & kelola admin)
CREATE TABLE IF NOT EXISTS super_admins (
  id         UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
  email      TEXT        UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_super_admins_email ON super_admins (email);

-- App config — key-value store untuk konfigurasi dinamis aplikasi
-- Digunakan untuk: registration_url, whatsapp_url, ws_url, maintenance mode, dll.
CREATE TABLE IF NOT EXISTS app_config (
  id         UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
  key        TEXT        UNIQUE NOT NULL,
  value      JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_config_key ON app_config (key);

-- ============================================================
-- SESSIONS (sudah ada sebelumnya — tetap dipertahankan)
-- ============================================================

CREATE TABLE IF NOT EXISTS sessions (
  user_id        TEXT PRIMARY KEY,
  email          TEXT,
  stockity_token TEXT,
  device_id      TEXT,
  device_type    TEXT        DEFAULT 'web',
  user_agent     TEXT,
  user_timezone  TEXT        DEFAULT 'Asia/Jakarta',
  currency       TEXT        DEFAULT 'IDR',
  currency_iso   TEXT        DEFAULT 'IDR',
  logged_out_at  TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TRADING CONFIG TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS schedule_configs (
  user_id         TEXT PRIMARY KEY,
  asset           JSONB,
  martingale      JSONB,
  is_demo_account BOOLEAN DEFAULT true,
  currency        TEXT    DEFAULT 'IDR',
  currency_iso    TEXT    DEFAULT 'IDR',
  stop_loss       NUMERIC DEFAULT 0,
  stop_profit     NUMERIC DEFAULT 0,
  orders          JSONB   DEFAULT '[]'::JSONB,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS aisignal_configs (
  user_id         TEXT PRIMARY KEY,
  asset           JSONB,
  base_amount     NUMERIC DEFAULT 1400000,
  martingale      JSONB,
  is_demo_account BOOLEAN DEFAULT true,
  currency        TEXT    DEFAULT 'IDR',
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS indicator_configs (
  user_id         TEXT PRIMARY KEY,
  asset           JSONB,
  settings        JSONB,
  martingale      JSONB,
  is_demo_account BOOLEAN DEFAULT true,
  currency        TEXT    DEFAULT 'IDR',
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fastrade_configs (
  user_id         TEXT PRIMARY KEY,
  asset           JSONB,
  martingale      JSONB,
  is_demo_account BOOLEAN DEFAULT true,
  currency        TEXT    DEFAULT 'IDR',
  stop_loss       NUMERIC DEFAULT 0,
  stop_profit     NUMERIC DEFAULT 0,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TRADING STATUS TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS schedule_status (
  user_id     TEXT PRIMARY KEY,
  bot_state   TEXT    DEFAULT 'STOPPED',
  started_at  TIMESTAMPTZ,
  stopped_at  TIMESTAMPTZ,
  session_pnl NUMERIC DEFAULT 0,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS aisignal_status (
  user_id    TEXT PRIMARY KEY,
  bot_state  TEXT DEFAULT 'STOPPED',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS indicator_status (
  user_id    TEXT PRIMARY KEY,
  bot_state  TEXT DEFAULT 'STOPPED',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fastrade_status (
  user_id         TEXT PRIMARY KEY,
  bot_state       TEXT DEFAULT 'STOPPED',
  mode            TEXT,
  asset           TEXT,
  is_demo_account BOOLEAN,
  started_at      TIMESTAMPTZ,
  stopped_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- LOGS & TRACKING
-- ============================================================

CREATE TABLE IF NOT EXISTS mode_logs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT        NOT NULL,
  mode        TEXT        NOT NULL,
  data        JSONB       NOT NULL,
  executed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mode_logs_user      ON mode_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_mode_logs_mode      ON mode_logs (mode);
CREATE INDEX IF NOT EXISTS idx_mode_logs_executed_at ON mode_logs (executed_at);
CREATE INDEX IF NOT EXISTS idx_mode_logs_user_mode ON mode_logs (user_id, mode, executed_at DESC);

CREATE TABLE IF NOT EXISTS order_tracking (
  user_id            TEXT PRIMARY KEY,
  bot_state          TEXT    DEFAULT 'STOPPED',
  orders             JSONB   DEFAULT '[]'::JSONB,
  session_pnl        NUMERIC DEFAULT 0,
  active_martingale  JSONB,
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_tracking_history (
  id          TEXT PRIMARY KEY,
  user_id     TEXT        NOT NULL,
  data        JSONB       NOT NULL,
  archived_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_tracking_history_user ON order_tracking_history (user_id);

-- ============================================================
-- TELEGRAM SIGNALS + REALTIME
-- ============================================================

CREATE TABLE IF NOT EXISTS telegram_signals (
  id               SERIAL PRIMARY KEY,
  trend            TEXT,
  hour             INTEGER,
  minute           INTEGER,
  second           INTEGER,
  original_message TEXT,
  execution_time   BIGINT,
  received_at      BIGINT,
  source           TEXT,
  processed_at     TIMESTAMPTZ DEFAULT NOW(),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Realtime publication setup
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime FOR TABLE telegram_signals;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE telegram_signals;
    EXCEPTION WHEN duplicate_object THEN
      NULL; -- already in publication, skip
    END;
  END IF;
END
$$;

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================

ALTER TABLE whitelist_users  ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users      ENABLE ROW LEVEL SECURITY;
ALTER TABLE super_admins     ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_config       ENABLE ROW LEVEL SECURITY;

-- ── whitelist_users ──────────────────────────────────────────
-- SELECT: boleh anon & authenticated
--   → frontend perlu cek isWhitelisted() & checkIsAdmin() langsung ke Supabase
-- INSERT/UPDATE/DELETE: hanya service_role (backend NestJS)
--   → data tidak bisa diubah dari browser
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'whitelist_users'
      AND policyname = 'Allow read whitelist for all'
  ) THEN
    CREATE POLICY "Allow read whitelist for all"
      ON whitelist_users FOR SELECT
      USING (true);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'whitelist_users'
      AND policyname = 'Allow write whitelist for service_role only'
  ) THEN
    CREATE POLICY "Allow write whitelist for service_role only"
      ON whitelist_users FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END
$$;

-- ── admin_users ───────────────────────────────────────────────
-- SELECT: boleh anon & authenticated
--   → frontend perlu cek checkIsAdmin() & checkIsSuperAdmin()
-- INSERT/UPDATE/DELETE: hanya service_role
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'admin_users'
      AND policyname = 'Allow read admin_users for all'
  ) THEN
    CREATE POLICY "Allow read admin_users for all"
      ON admin_users FOR SELECT
      USING (true);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'admin_users'
      AND policyname = 'Allow write admin_users for service_role only'
  ) THEN
    CREATE POLICY "Allow write admin_users for service_role only"
      ON admin_users FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END
$$;

-- ── super_admins ──────────────────────────────────────────────
-- SELECT: boleh anon & authenticated
--   → frontend perlu cek checkIsSuperAdmin()
-- INSERT/UPDATE/DELETE: hanya service_role
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'super_admins'
      AND policyname = 'Allow read super_admins for all'
  ) THEN
    CREATE POLICY "Allow read super_admins for all"
      ON super_admins FOR SELECT
      USING (true);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'super_admins'
      AND policyname = 'Allow write super_admins for service_role only'
  ) THEN
    CREATE POLICY "Allow write super_admins for service_role only"
      ON super_admins FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END
$$;

-- ── app_config ────────────────────────────────────────────────
-- SELECT: boleh anon & authenticated
--   → frontend perlu baca registrationUrl & whatsappHelpUrl
-- INSERT/UPDATE/DELETE: hanya service_role
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'app_config'
      AND policyname = 'Allow read app_config for all'
  ) THEN
    CREATE POLICY "Allow read app_config for all"
      ON app_config FOR SELECT
      USING (true);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'app_config'
      AND policyname = 'Allow write app_config for service_role only'
  ) THEN
    CREATE POLICY "Allow write app_config for service_role only"
      ON app_config FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END
$$;

-- ============================================================
-- CATATAN PENGGUNAAN
-- ============================================================
-- 1. Jalankan file ini SEKALI di Supabase SQL Editor.
-- 2. Frontend (anon key) hanya bisa SELECT — tidak bisa ubah data.
-- 3. Backend NestJS (service_role key) bypass RLS — bisa semua operasi.
-- 4. Setelah schema, jalankan seed-super-admin.sql untuk akun pertama.
-- ============================================================