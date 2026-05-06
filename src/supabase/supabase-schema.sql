-- Supabase Schema for STC AutoTrade Migration
-- Run this in your Supabase SQL Editor to create all required tables.

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Sessions table (replaces Firestore 'sessions/{userId}')
CREATE TABLE IF NOT EXISTS sessions (
  user_id TEXT PRIMARY KEY,
  email TEXT,
  stockity_token TEXT,
  device_id TEXT,
  device_type TEXT DEFAULT 'web',
  user_agent TEXT,
  user_timezone TEXT DEFAULT 'Asia/Jakarta',
  currency TEXT DEFAULT 'IDR',
  currency_iso TEXT DEFAULT 'IDR',
  logged_out_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Schedule configs (replaces Firestore 'schedule_configs/{userId}')
CREATE TABLE IF NOT EXISTS schedule_configs (
  user_id TEXT PRIMARY KEY,
  asset JSONB,
  martingale JSONB,
  is_demo_account BOOLEAN DEFAULT true,
  currency TEXT DEFAULT 'IDR',
  currency_iso TEXT DEFAULT 'IDR',
  stop_loss NUMERIC DEFAULT 0,
  stop_profit NUMERIC DEFAULT 0,
  orders JSONB DEFAULT '[]'::JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI Signal configs (replaces Firestore 'aisignal_configs/{userId}')
CREATE TABLE IF NOT EXISTS aisignal_configs (
  user_id TEXT PRIMARY KEY,
  asset JSONB,
  base_amount NUMERIC DEFAULT 1400000,
  martingale JSONB,
  is_demo_account BOOLEAN DEFAULT true,
  currency TEXT DEFAULT 'IDR',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indicator configs (replaces Firestore 'indicator_configs/{userId}')
CREATE TABLE IF NOT EXISTS indicator_configs (
  user_id TEXT PRIMARY KEY,
  asset JSONB,
  settings JSONB,
  martingale JSONB,
  is_demo_account BOOLEAN DEFAULT true,
  currency TEXT DEFAULT 'IDR',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- FastTrade configs (if needed; not heavily used in uploaded files but safe to include)
CREATE TABLE IF NOT EXISTS fastrade_configs (
  user_id TEXT PRIMARY KEY,
  asset JSONB,
  martingale JSONB,
  is_demo_account BOOLEAN DEFAULT true,
  currency TEXT DEFAULT 'IDR',
  stop_loss NUMERIC DEFAULT 0,
  stop_profit NUMERIC DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Schedule status (replaces Firestore 'schedule_status/{userId}')
CREATE TABLE IF NOT EXISTS schedule_status (
  user_id TEXT PRIMARY KEY,
  bot_state TEXT DEFAULT 'STOPPED',
  started_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ,
  session_pnl NUMERIC DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI Signal status (replaces Firestore 'aisignal_status/{userId}')
CREATE TABLE IF NOT EXISTS aisignal_status (
  user_id TEXT PRIMARY KEY,
  bot_state TEXT DEFAULT 'STOPPED',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indicator status (replaces Firestore 'indicator_status/{userId}')
CREATE TABLE IF NOT EXISTS indicator_status (
  user_id TEXT PRIMARY KEY,
  bot_state TEXT DEFAULT 'STOPPED',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- FastTrade status (replaces Firestore 'fastrade_status/{userId}')
CREATE TABLE IF NOT EXISTS fastrade_status (
  user_id TEXT PRIMARY KEY,
  bot_state TEXT DEFAULT 'STOPPED',
  mode TEXT,
  asset TEXT,
  is_demo_account BOOLEAN,
  started_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Mode logs - unified table with mode column
-- Replaces Firestore subcollections: schedule_logs/{uid}/entries, aisignal_logs/{uid}/entries, etc.
CREATE TABLE IF NOT EXISTS mode_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  data JSONB NOT NULL,
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mode_logs_user ON mode_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_mode_logs_mode ON mode_logs (mode);
CREATE INDEX IF NOT EXISTS idx_mode_logs_executed_at ON mode_logs (executed_at);
CREATE INDEX IF NOT EXISTS idx_mode_logs_user_mode ON mode_logs (user_id, mode, executed_at DESC);

-- Order tracking (replaces Firestore 'order_tracking/{userId}')
CREATE TABLE IF NOT EXISTS order_tracking (
  user_id TEXT PRIMARY KEY,
  bot_state TEXT DEFAULT 'STOPPED',
  orders JSONB DEFAULT '[]'::JSONB,
  session_pnl NUMERIC DEFAULT 0,
  active_martingale JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Order tracking history (replaces Firestore 'order_tracking_history/{historyId}')
CREATE TABLE IF NOT EXISTS order_tracking_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  data JSONB NOT NULL,
  archived_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_order_tracking_history_user ON order_tracking_history (user_id);

-- Telegram signals (replaces Firestore 'telegram_signals' collection)
CREATE TABLE IF NOT EXISTS telegram_signals (
  id SERIAL PRIMARY KEY,
  trend TEXT,
  hour INTEGER,
  minute INTEGER,
  second INTEGER,
  original_message TEXT,
  execution_time BIGINT,
  received_at BIGINT,
  source TEXT,
  processed_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create a publication for realtime (Supabase realtime requires this)
-- Do this only if the tables are not already in a publication
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime FOR TABLE telegram_signals;
  END IF;
END
$$;

-- Add telegram_signals to realtime publication if publication already exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE telegram_signals;
  END IF;
END
$$;
