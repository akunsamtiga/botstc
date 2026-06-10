-- ============================================================
-- CLEANUP: buang key lama registrationUrl & registrationPrimaryUrl
-- dari app_config (key = 'registration')
-- ============================================================
-- Key ini sisa alur registrasi webview lama (registerpage.tsx) yang sudah
-- dihapus. Alur register sekarang (inline + cookie referral stockityReferral)
-- tidak memakainya. Aman dibuang.
--
-- Jalankan di Supabase SQL Editor. Idempoten & MERGE-safe: field config lain
-- (whatsappHelpUrl, stockityReferral, minStockity, dll) tetap utuh.
-- ============================================================

UPDATE app_config
SET value =
      -- Normalisasi ke objek jsonb (tahan kasus value tersimpan sbg string),
      -- lalu hapus dua key lama. Operator `-` membuang key dari objek jsonb.
      (CASE
         WHEN jsonb_typeof(value) = 'object' THEN value
         WHEN jsonb_typeof(value) = 'string' THEN (value #>> '{}')::jsonb
         ELSE '{}'::jsonb
       END) - 'registrationUrl' - 'registrationPrimaryUrl',
    updated_at = now()
WHERE key = 'registration';

-- ── Verifikasi: dua key harus hilang, stockityReferral tetap ada ───────────
SELECT
  value ? 'registrationUrl'        AS masih_ada_registrationUrl,        -- harus: false
  value ? 'registrationPrimaryUrl' AS masih_ada_registrationPrimaryUrl, -- harus: false
  value ->> 'stockityReferral'     AS stockity_referral,                -- tetap terisi
  value ->> 'whatsappHelpUrl'      AS whatsapp_help_url
FROM app_config
WHERE key = 'registration';
