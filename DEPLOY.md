# Deploy stcvps ke VPS

> Panduan ini untuk VPS yang sudah melakukan `git pull` dari GitHub.

---

## Prasyarat

- OS VPS: Ubuntu / Debian
- Project sudah ada di VPS (sudah `git pull`)

---

## Langkah 1 — Install Node.js 18+ dan PM2

```bash
# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Verifikasi
node -v   # harus >= v18
npm -v

# Install PM2
npm install -g pm2
```

---

## Langkah 2 — Masuk ke direktori project

```bash
cd /root/stcvps
```

---

## Langkah 3 — Buat file `.env`

File `.env` tidak ikut git (ada di `.gitignore`), harus dibuat manual di VPS.

```bash
nano .env
```

Isi:

```env
# Supabase
SUPABASE_URL=https://njnrrwuhflnwumxjivca.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<salin_dari_lokal>

# Firebase FCM
FCM_SERVICE_ACCOUNT_PATH=./firebase-service-account.json

# JWT
JWT_SECRET=<salin_dari_lokal>

# App
PORT=3001

# Proxy login Stockity (kosongkan dulu, isi jika IP VPS diblok Stockity)
LOGIN_PROXY=
```

Simpan: `Ctrl+O` → `Enter` → `Ctrl+X`

---

## Langkah 4 — Upload `firebase-service-account.json`

File ini juga tidak ada di git. Upload dari PC lokal:

```bash
# Jalankan dari PowerShell / terminal PC lokal:
scp "d:\Pemrograman\Nest JS\STC3\stcvps\firebase-service-account.json" root@IP_VPS:/root/stcvps/
```

Bisa juga pakai **FileZilla** atau **WinSCP** jika lebih nyaman.

---

## Langkah 5 — Install dependencies dan build

```bash
npm install
npm run build
mkdir -p logs
```

---

## Langkah 6 — Jalankan dengan PM2

```bash
pm2 start ecosystem.config.js
```

Cek status:

```bash
pm2 status
pm2 logs stcautotrade --lines 50
```

Kalau berhasil, log akan tampil:

```
🚀 Stockity Schedule VPS running on port 3001
```

---

## Langkah 7 — PM2 auto-start saat reboot

```bash
pm2 save
pm2 startup
```

Jalankan satu baris perintah yang muncul dari output `pm2 startup`.

---

## Langkah 8 — Test API

```bash
curl http://localhost:3001/api/v1/auth/me
# Harus return 401 Unauthorized → server berjalan normal
```

---

## Perintah PM2 yang sering dipakai

| Perintah | Fungsi |
|---|---|
| `pm2 status` | Lihat status semua app |
| `pm2 logs stcautotrade` | Live log |
| `pm2 restart stcautotrade` | Restart app |
| `pm2 stop stcautotrade` | Stop app |
| `pm2 delete stcautotrade` | Hapus dari PM2 |

---

## Deploy setelah update kode

```bash
cd /root/stcvps
git pull
npm install        # jika ada dependency baru
npm run build
pm2 restart stcautotrade
```

---

## Troubleshooting: IP VPS diblok Stockity

Jika login gagal dengan error `401`/`403` dari Stockity, kemungkinan IP VPS diblok.

### Opsi A — SSH SOCKS5 tunnel dari PC lokal

```bash
# Jalankan di PC lokal (biarkan terminal ini terbuka):
ssh -D 1080 -N root@IP_VPS
```

Lalu di `.env` VPS ubah:

```env
LOGIN_PROXY=socks5h://127.0.0.1:1080
```

### Opsi B — Proxy server eksternal

```env
LOGIN_PROXY=http://IP_PROXY_BERSIH:PORT
```

Setelah edit `.env`, restart app:

```bash
pm2 restart stcautotrade
```
