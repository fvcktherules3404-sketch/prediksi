# Backtest (validasi parameter di data lama)

Tujuan: menguji mesin (`scripts/engine.ts`) pada ribuan laga lama, tanpa menunggu 150 laga live. Setiap laga diprediksi hanya dari laga sebelumnya (walk-forward). Parameter dituning pada 70% laga pertama dan **diuji pada 30% terakhir**.

## Cara pakai
1. Unduh CSV gratis dari https://www.football-data.co.uk (halaman "Data" tiap negara). Simpan di `data/backtest/` dengan nama `KODELIGA-MUSIM.csv`, contoh `E0-2223.csv`, `E0-2324.csv`, `E0-2425.csv`, `SP1-2324.csv`, `D1-2324.csv`, `I1-2324.csv`, `F1-2324.csv`.
   - Format lama (satu file per liga per musim): kolom `Date, HomeTeam, AwayTeam, FTHG, FTAG` dan odds `PSH/PSD/PSA` atau `B365H/B365D/B365A` atau `AvgH/AvgD/AvgA`.
   - Format "new" (liga lain, banyak musim dalam satu file): kolom `League, Season, Date, Home, Away, HG, AG` dan odds `PH/PD/PA`, `AvgH/AvgD/AvgA`. Musim dibaca dari kolom `Season`.
2. `npm run backtest` (atau `npm run backtest -- --dir=lokasi --warmup=20 --split=0.7 --closing=true`).
3. Hasil tercetak di konsol dan tersimpan di `data/backtest-report.json`.

Butuh minimal ~500 laga yang bisa dinilai, idealnya 3000+ (3-5 musim, beberapa liga). Musim pertama tiap liga dipakai sebagai pemanasan Elo (`--warmup` laga per tim).

## Cara membaca
- **A.** Bandingkan model dengan baseline dan pasar. Log-loss acak = 1,0986. Model yang tidak mengalahkan "frekuensi liga" berarti belum menambah informasi.
- **B/C.** Nilai `eloSlope`, `eloShrinkK`, `rho`, `drawBoost`, `tempoSpread` yang terbaik di set latih, dan apakah perbaikannya **nyata** di set uji (selisih dibanding ±1,96 galat baku). Kalau "belum berbeda nyata", biarkan default.
- **D.** Bobot pasar (`marketWeight`) dan ketajaman (`tau`) yang terbaik, dan apakah gabungan mengalahkan pasar murni. Mengalahkan pasar secara nyata itu sangat sulit; hasil realistis adalah "setara".
- **E.** Aturan pick "Seri" (`decide1x2`) vs argmax biasa. Kalau `decide1x2` menurunkan akurasi, pertimbangkan hanya menampilkan Seri sebagai peluang, bukan pick.
- **F.** Di tahap musim mana Elo unggul atas klasemen (dasar memilih `eloShrinkK`).
- **G.** Over 2.5 dan BTTS, hanya dilaporkan.

## Batasan
- Elo dihitung dari hasil liga yang sama, bukan ClubElo / eloratings.net. `eloSlope` hasilnya hanya pendekatan; tim nasional butuh data internasional tersendiri.
- Odds default adalah odds pra-penutupan (mirip waktu aplikasi mengambil odds). `--closing=true` memakai odds penutupan yang lebih tajam, sebagai batas atas.
- Data cedera, opini AI, dan berita tidak ikut diuji (tidak ada datanya di CSV).
