-- ============================================================
-- STC — ENABLE RLS + VERIFIKASI (jalankan SEKALI di Supabase SQL Editor)
-- ============================================================
-- Aman: backend pakai service_role (bypass RLS) → tetap jalan.
-- Frontend tidak pernah mengakses tabel-tabel ini → tidak ada yang rusak.
-- ============================================================

DO $$
DECLARE
  t text;
  targets text[] := ARRAY[
    'sessions',
    'schedule_configs','aisignal_configs','indicator_configs','fastrade_configs',
    'schedule_status','aisignal_status','indicator_status','fastrade_status',
    'mode_logs','order_tracking','order_tracking_history','telegram_signals'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
      RAISE NOTICE 'RLS enabled: %', t;
    ELSE
      RAISE NOTICE 'SKIP (tabel tidak ada): %', t;
    END IF;
  END LOOP;
END $$;

-- VERIFIKASI — semua baris HARUS rls_enabled = true.
-- Baris dengan false (jika ada) muncul paling atas = tabel yang masih terbuka.
SELECT relname AS table_name, relrowsecurity AS rls_enabled
FROM pg_class
WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace
ORDER BY relrowsecurity ASC, relname;
