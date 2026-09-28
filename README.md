# ⚽ Prediksi Bola Statistik — 100% Gratis

GitHub Actions (cron 23:00 UTC = 06:00 WIB) → API-Football → mesin Poisson/Dixon-Coles (TypeScript) → Gemini (opsional, hanya ringkasan teks) → `public/data/predictions.json` → commit → build React → GitHub Pages. Tanpa server, database, Firebase, atau kartu kredit.

## Cara pasang (±10 menit)
1. Buat **repository public** di GitHub, upload seluruh isi folder ini (branch `main`).
2. Daftar gratis di **api-football.com** (dashboard.api-football.com) → salin API key.
3. Ambil Gemini key gratis di **aistudio.google.com/apikey** (opsional).
4. Repo → *Settings → Secrets and variables → Actions* → tambahkan `FOOTBALL_API_KEY` dan `GEMINI_API_KEY`.
5. *Settings → Actions → General → Workflow permissions* → **Read and write permissions**.
6. *Settings → Pages → Source* → **GitHub Actions**.
7. *Actions → Daily Predictions → Run workflow*. Setelah hijau, situs ada di `https://USERNAME.github.io/NAMA-REPO/`.

## Perilaku
- Window: 06:00 WIB terakhir s/d +24 jam − 1 detik, dihitung dari waktu eksekusi **aktual** (cron GitHub bisa telat).
- Request API dihemat: 2 fixture + 1 klasemen per liga (klasemen sudah berisi gol kandang/tandang & form). Cache di `data/cache`, hitungan kuota di `scripts/apiUsage.ts`.
- Gagal API → pakai cache jika masih valid, jika tidak → tidak membuat pertandingan apa pun dan `predictions.json` lama dipertahankan.
- Gemini gagal/kuota habis → prediksi tetap ada, ringkasan "AI analysis unavailable."
- Penulisan atomik: `predictions.tmp.json` → rename ke `predictions.json` hanya jika valid. Riwayat di `public/data/history/YYYY-MM-DD.json`.
- Situs tetap ditampilkan (data terakhir) walau job gagal.

## Kustomisasi
- Liga: edit `scripts/config.ts` (`DEFAULT_LEAGUES`) atau env `LEAGUE_IDS="39,140"`; `ALL_LEAGUES=true` untuk semua (boros kuota).
- Batas harian: env `FOOTBALL_DAILY_LIMIT`. Model Gemini: env `GEMINI_MODEL`.
- Rumus: `docs/MODEL.md`, kode di `scripts/engine.ts`. Biaya: `docs/COST.md`.

## Lokal
`npm install` → `npm test` → `FOOTBALL_API_KEY=... npm run predict` → `npm run dev`.
