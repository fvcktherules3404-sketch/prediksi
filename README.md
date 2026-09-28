# ⚽ Prediksi Bola Statistik — 100% Gratis

GitHub Actions (cron 23:00 UTC = 06:00 WIB) → API-Football → mesin Poisson/Dixon-Coles (TypeScript) → Gemini (opsional, hanya ringkasan teks) → `public/data/predictions.json` → commit → build React → GitHub Pages. Tanpa server, database, Firebase, atau kartu kredit.

## Sumber data klasemen (3 lapis, otomatis)
Paket gratis API-Football tidak menyediakan klasemen musim berjalan, jadi klasemen dicari berlapis per tim (`scripts/run.ts`):
1. **Resmi — football-data.org** (opsional, secret `FOOTBALL_DATA_KEY`): klasemen lengkap sejak hari pertama untuk 12 kompetisi (PL, ELC, La Liga, Serie A, Bundesliga, Ligue 1, Eredivisie, Primeira, Brasileirão, UCL, Euro, Piala Dunia). Dicocokkan ke tim API-Football lewat nama.
2. **Hasil sendiri — API-Football**: tiap run mengambil fixture yang sudah selesai (1 request/hari) → `data/results.json` (gol kandang/tandang, jumlah laga, form 5 laga, poin). Cocok untuk liga di luar 12 besar; makin lama makin akurat. Saat file masih kosong, run pertama mengisi mundur `BACKFILL_DAYS` hari (default 5; kalau paket gratis menolak tanggal lampau, pengumpulan berhenti tanpa merusak apa pun dan berlanjut harian).
3. **Gemini + Google Search** (opsional, untuk tim yang tidak punya data / sampel < 3 laga): hasilnya dibuang kecuali respons benar-benar ter-grounding (ada sumber web), semua angka lolos validasi (bilangan bulat, gol/laga wajar, laga kandang≈tandang, tidak lebih sedikit dari data sendiri, jumlah laga dekat median liga). Yang lolos ditandai **AI?** di kartu dan keyakinan prediksi diturunkan 40%. Lewati turnamen antarnegara (`noStandingsLeagues`). Matikan dengan `GEMINI_STANDINGS=false`.

Tim yang tidak punya data dari ketiganya dilewati (tidak dikarang). Ringkasan teks Gemini tetap terpisah dan tidak mengubah angka.


## Cara pasang (±10 menit)
1. Buat **repository public** di GitHub, upload seluruh isi folder ini (branch `main`).
2. Daftar gratis di **api-football.com** (dashboard.api-football.com) → salin API key.
3. Ambil Gemini key gratis di **aistudio.google.com/apikey** (opsional).
4. Repo → *Settings → Secrets and variables → Actions* → tambahkan `FOOTBALL_API_KEY`, `GEMINI_API_KEY`, dan (opsional) `FOOTBALL_DATA_KEY` (daftar gratis di football-data.org).
5. *Settings → Actions → General → Workflow permissions* → **Read and write permissions**.
6. *Settings → Pages → Source* → **GitHub Actions**.
7. *Actions → Daily Predictions → Run workflow*. Setelah hijau, situs ada di `https://USERNAME.github.io/NAMA-REPO/`.

## Perilaku
- Window: 06:00 WIB terakhir s/d +24 jam − 1 detik, dihitung dari waktu eksekusi **aktual** (cron GitHub bisa telat).
- Request API-Football: 2 fixture hari ini + 1 per hari hasil kemarin (bukan endpoint klasemen; aktifkan lagi dengan `USE_API_STANDINGS=true` jika paketmu mengizinkan). Cache di `data/cache`, hitungan kuota di `scripts/apiUsage.ts`.
- Gagal API → pakai cache jika masih valid, jika tidak → tidak membuat pertandingan apa pun dan `predictions.json` lama dipertahankan.
- Gemini gagal/kuota habis → prediksi tetap ada, ringkasan "AI analysis unavailable."
- Penulisan atomik: `predictions.tmp.json` → rename ke `predictions.json` hanya jika valid. Riwayat di `public/data/history/YYYY-MM-DD.json`.
- Situs tetap ditampilkan (data terakhir) walau job gagal.

## Kustomisasi
- Liga: edit `scripts/config.ts` (`DEFAULT_LEAGUES`) atau env `LEAGUE_IDS="39,140"`; `ALL_LEAGUES=true` untuk semua (boros kuota).
- Batas harian: env `FOOTBALL_DAILY_LIMIT`. Data awal: `BACKFILL_DAYS` (juga input saat Run workflow). Model Gemini: env `GEMINI_MODEL`.
- Rumus: `docs/MODEL.md`, kode di `scripts/engine.ts`. Biaya: `docs/COST.md`.

## Lokal
`npm install` → `npm test` → `FOOTBALL_API_KEY=... npm run predict` → `npm run dev`.

## Peringkat Elo (klub & tim nasional)
Sumber kekuatan tim tambahan, gratis dan tanpa API key:
- **Tim nasional** (Piala Dunia, Euro, Nations League, Copa America, AFCON, Friendlies): eloratings.net.
- **Klub Eropa** (liga besar, Liga Champions/Europa/Conference): ClubElo (api.clubelo.com).

Cara pakai di mesin (`scripts/engine.ts`): selisih Elo diubah menjadi xG (`exp(0.0014 × selisih)`, total gol mengikuti rata-rata liga; turnamen final dianggap netral).
- Tim **tanpa klasemen**: 100% Elo (badge **Elo**, keyakinan sedikit diturunkan).
- Tim **dengan klasemen**: gabungan di ruang log, bobot klasemen = laga/(laga+8), sisanya Elo.
- Tim yang tidak cocok namanya, tim usia (U17-U23), wanita, dan klub non-Eropa tidak dicoba; tidak ada data yang dikarang.
- Matikan dengan `USE_ELO=false`. Parameter ada di `scripts/config.ts` (`eloSlope`, `eloShrinkK`).
