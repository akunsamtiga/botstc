-- ============================================================
-- SET kode referral Stockity di app_config (key = 'registration')
-- ============================================================
-- Backend register() membaca app_config.registration.value.stockityReferral
-- lalu mengirimnya sebagai cookie `a=<kode>` saat sign_up ke Stockity.
-- Cukup KODE-nya saja (bukan URL penuh) — domain di link tidak dipakai backend.
--
-- Link penuh : https://stockity-r3.com/?a=8620c08b51a6&t=0#auth
-- Kode (`a`) : 8620c08b51a6   ← ini yang disimpan.
--
-- Jalankan di Supabase SQL Editor (service_role / owner).
-- Idempoten & MERGE: hanya field stockityReferral yang diubah, field config
-- lain (whatsappHelpUrl, minStockity, dll) tetap utuh.
-- ============================================================

INSERT INTO app_config (key, value, updated_at)
VALUES (
  'registration',
  jsonb_build_object('stockityReferral', '8620c08b51a6'),
  now()
)
ON CONFLICT (key) DO UPDATE
SET value =
      -- Normalisasi value lama ke objek jsonb (tahan kasus tersimpan sbg string),
      -- lalu merge dengan kode referral baru (kunci kanan menang).
      (CASE
         WHEN jsonb_typeof(app_config.value) = 'object' THEN app_config.value
         WHEN jsonb_typeof(app_config.value) = 'string' THEN (app_config.value #>> '{}')::jsonb
         ELSE '{}'::jsonb
       END)
      || jsonb_build_object('stockityReferral', '8620c08b51a6'),
    updated_at = now();

-- ── Verifikasi ─────────────────────────────────────────────────────────────
SELECT
  key,
  value ->> 'stockityReferral' AS stockity_referral,
  value ->> 'whatsappHelpUrl'  AS whatsapp_help_url,
  updated_at
FROM app_config
WHERE key = 'registration';
