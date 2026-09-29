# Rumus model (semua di TypeScript, tanpa AI)

1. **Rata-rata liga** (dihaluskan prior 1.45/1.15 gol, bobot 10 laga): `lgHome`, `lgAway`.
2. **Kekuatan tim** (dari klasemen): `att = 0.5·(GF venue / rata2 venue) + 0.5·(GF total / rata2 total)`; `def` serupa dari GA.
3. **Shrinkage Bayesian**: `v' = 1 + n/(n+6)·(v−1)` → sampel kecil ditarik ke rata-rata liga.
4. **Gol harapan (xG model)**: `λ_home = lgHome·att_H·def_A·(1+0.03·Δform)`, `λ_away = lgAway·att_A·def_H·(1−0.03·Δform)`; Δform = skor 5 laga terakhir (W=+1, D=0, L=−1) home − away.
5. **Poisson + Dixon-Coles** (ρ = −0.08) untuk skor 0-0, 1-0, 0-1, 1-1; matriks 11×11 dinormalisasi.
6. **Turunan**: 1X2, double chance, Over/Under 1.5/2.5/3.5, BTTS, 5 skor teratas.
7. **Handicap Asia** (kelipatan ¼): peluang win / half-win / push / half-loss / loss, fair odds `1 + P(gagal)/P(menang)`, dan garis adil (edge≈0).
8. **Keyakinan** = `100·clamp((maxP−0.34)/0.5)·(0.5+0.5·min(1, laga/10))`.
(Rumus keyakinan di butir 8 diganti oleh versi v2 di bagian bawah.) Cedera dihitung sebagian (laporan API/berita), susunan resmi dan cuaca tidak.


## Pembaruan kalibrasi
- **Campuran tempo** (3 skenario, rata-rata xG tetap): gol kedua tim berkorelasi, ekor Over/Under lebih realistis.
- **Inflasi seri** (`drawBoost`): diagonal skor seri dinaikkan, terbesar saat laga seimbang.
- **Keputusan 1X2** (`decide1x2`): pick "Seri" bila selisih menang-kalah < 7 poin persen dan seri >= 25%, atau seri hanya kalah <= 3 poin dari yang teratas.
- **Aman**: double chance dengan peluang tertinggi.
- Model Gemini otomatis dicari lewat ListModels bila nama model 404.


## v2 — pasar, kalibrasi, keyakinan
1. **Probabilitas pasar**: odds bandar (API-Football `/odds`, 1 request/laga) → margin dibuang dengan metode pangkat (`Σ(1/odds)^k = 1`) → rata-rata berbobot antar bandar (Pinnacle 3×, pencilan > 12 poin dari median dibuang). Over/Under 2.5 ikut bila tersedia. Odds hanya dipakai sebagai sinyal statistik, tidak ditampilkan sebagai saran taruhan.
2. **Penggabungan**: `p ∝ p_model^(1−w) · p_pasar^w` (ruang log), `w = marketWeight` (awal 0,6; ×0,7 bila < 3 bandar). Laga tanpa odds = model murni.
3. **Fit ulang xG**: (λ_home, λ_away) dicari lagi agar matriks skor cocok dengan 1X2 gabungan (dan Over 2.5 gabungan), jadi skor teratas, O/U, BTTS, dan handicap tetap konsisten dengan 1X2.
4. **Temperatur** `p ∝ p^tau` untuk ketajaman. `tau = 1` sampai ≥ 150 laga dinilai; sesudahnya dituning otomatis dari log-loss (ditarik ke 1 bila sampel masih kecil, dibatasi 0,85–1,25).
5. **Keyakinan v2** = `100 · ketegasan × (0,5 + 0,5·kualitas) × kesepakatan × jenis_laga`
   - ketegasan = `clamp((maxP − 0,34)/0,5)` pada peluang akhir
   - kualitas = `0,30 + 0,25·[Elo ada] + 0,25·min(1, laga/15) + 0,25·[odds ada]·min(1, bandar/3)` (×0,6 bila data klasemen dari AI)
   - kesepakatan = `1 − clamp((TV_model_vs_pasar − 0,05)·1,5, 0, 0,35)`, ×0,9 bila pick model ≠ pick pasar
   - jenis laga = 0,85 untuk persahabatan
   - Opini AI: +4 bila sepakat, −8 bila beda (`aiAgreeBonus`, `aiDisagreePenalty`); lihat `calibration.json → ai` untuk mengecek apakah AI memang membantu.
6. **Rekam jejak** (`scripts/evaluate.ts`): tiap run, prediksi di `public/data/history/` dinilai terhadap skor 90 menit (`data/results.json`) → `public/data/calibration.json`: akurasi, Brier, log-loss, tabel kalibrasi per level keyakinan, dan perbandingan model vs pasar. Bobot pasar dituning otomatis setelah ≥ 60 laga ber-odds.
