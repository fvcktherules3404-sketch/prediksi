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

## v3: taruhan laga (situasi tabel) dan fase musim
Masukan pengguna: (1) awal musim banyak gol, akhir musim "main aman" sehingga gol lebih sedikit; (2) tim yang sudah aman (mis. 4 besar) tidak ngoyo, tim yang mengejar poin lebih agresif. Keduanya diuji dulu di data (`npm run backtest`, bagian **H**, latih 70% / uji 30% terbaru, 12.797 laga liga domestik kandang-tandang penuh) sebelum dipakai.

**Hasil uji**
| Usulan | Hasil di hold-out | Keputusan |
|---|---|---|
| Akhir musim = gol lebih sedikit (fase −0,1) | Over/Under 2.5 **memburuk** nyata (+0,0030 ± 0,0011); model justru sedikit *meremehkan* gol di paruh akhir (Over 2.5 diprediksi 48,1% vs nyata 51,7% pada fase 0,9–1,0) | **Tidak dipakai** (`stakesPhase = 0`) |
| Tim berebut target vs tim tanpa target (efek relatif) | Log-loss 1X2 membaik nyata (−0,0032 ± 0,0013), Over/Under tak bergeser (−0,0002 ± 0,0003) | **Dipakai** (`stakesRel = 0.2`) |
| Fase ke arah gol lebih BANYAK (+0,1) | Over/Under membaik tipis (−0,0018 ± 0,0011), batas nyata | Belum dipakai (`stakesPhase = 0`); kandidat bila data live mengonfirmasi |
| Efek level (kedua tim berebut → total gol berubah) | Tidak konsisten | Tidak dipakai (`stakesLevel = 0`) |

**Cara kerja** (`scripts/stakes.ts`)
1. Untuk tiap tim dihitung jarak poin ke garis terdekat dari {juara, batas 4 besar, batas degradasi}, dibagi poin yang masih bisa diambil (3 × sisa laga + 3). `need = exp(−jarak / 0,3)`: 1 = tepat di garis (berebut), 0 = tanpa target.
2. Label di kartu: *Mengejar juara / Menjaga puncak / Mengejar 4 besar / Menjaga 4 besar / Terancam degradasi / Menjauh dari degradasi / Aman / tanpa target*.
3. xG dikali `exp(±rel × (need_kandang − need_tandang) / 2)`: tim yang lebih butuh naik, lawan yang lebih santai turun, **total gol dijaga** sehingga Over/Under tidak terganggu.
4. Hanya untuk liga domestik kandang-tandang penuh (`CFG.stakesLeagues`) dengan poin dari sumber resmi atau hasil sendiri, dan setelah ≥ 25% musim. Piala, fase liga Eropa, liga dengan split/playoff/konferensi: tanpa label dan tanpa penyesuaian.
5. Label dan konteks juga dikirim ke prompt opini AI.

Efek nyata kecil (±3–5% pada xG di laga ekstrem). Matikan dengan `STAKES=false`; jalankan ulang backtest setelah data bertambah sebelum mengubah `STAKES_REL / STAKES_LEVEL / STAKES_PHASE`.
**Batasan:** belum diuji untuk fase gugur dua leg (agregat), fase liga UCL/UEL, atau musim pendek; ambang "garis 4 besar" berlaku generik (bukan jatah Eropa tiap liga); data uji didominasi liga Amerika Selatan/Asia/Norwegia + Eropa musim ini.


## Konteks laga v5 (`scripts/context.ts`)

Cakupan diperluas melampaui tabel liga domestik. Semua sakelar ada di `CFG.ctx*` (env `CTX_FATIGUE`, `CTX_LEG2`, `CTX_FINAL`, `CTX_DERBY`, `CTX_GROUP` = `false` untuk mematikan).

| Konteks | Cara kerja | Efek | Status bukti |
|---|---|---|---|
| Juara/degradasi pasti | `stakes.ts`: pemuncak dengan selisih > 3 x sisa laga = "Sudah juara" (need 0); poin maksimum < batas aman = "Sudah degradasi" | lawan yang masih berebut dinilai lebih tajam (lewat `stakesRel`) | backtest H diulang: 111 dari 3.840 laga uji berubah, selisih log-loss -0,00001 ± 0,00006 (netral) |
| Kelelahan | jeda hari sejak laga terakhir (semua kompetisi, dari `results.json` + jadwal window) + jumlah laga 10 hari | `ctxFatigueRel` = 0 (label saja) | backtest I (27.927 laga klub): tidak ada pengaruh nyata; terbaik di set latih = 0 |
| Leg kedua | leg 1 disimpan di `results.legs`; agregat = gol tim di leg 1 - gol lawan | `ctxLeg2K` 0,05 per gol agregat (maks 2 gol) | belum diuji (tidak ada data agregat di repo) |
| Final | babak persis "Final" | total gol -4%, keyakinan x0,9 | belum diuji |
| Derbi | daftar pasangan di `DERBIES`, cocok persis nama | keyakinan x0,93, xG tidak diubah | belum diuji |
| Grup timnas | klasemen grup API-Football (maks 4 request/run); status `through` / `out` / `alive` secara matematis, seri poin dianggap belum pasti | `ctxGroupRel` 0,12 (relatif, total dijaga); dua tim sama-sama tanpa taruhan -> keyakinan x0,9 | belum diuji |

**Batasan:** riwayat jeda hanya ada untuk laga yang sudah terkumpul di `results.json` (mulai dari saat sistem berjalan), jadi tim tanpa riwayat tidak dapat penyesuaian. Klasemen grup butuh 1 request per turnamen dan bisa kosong di paket gratis; bila kosong, laga tetap diprediksi tanpa konteks grup. Slot lolos diambil dari deskripsi API bila ada, kalau tidak dianggap 2 per grup. Kualifikasi dan Nations League dianggap kandang-tandang (konservatif). Daftar derbi perlu dirawat manual.


## v6: AI ikut membaca konteks laga (`scripts/aiContext.ts`)

Konteks yang **tidak bisa dihitung dari angka** kini juga dibaca AI dari berita web: rotasi pemain yang diumumkan, motivasi (sudah juara / sudah degradasi / sudah lolos / sudah gugur / fokus ke laga lain), kelelahan nyata (perpanjangan waktu, perjalanan jauh), skor leg 1 yang belum tercatat sistem, dan derbi yang belum ada di daftar.

**Tanpa biaya tambahan.** Permintaan konteks ikut di prompt berita cedera yang sudah ada (`news.ts`), memakai hasil Tavily yang sudah di-cache per laga (`searchMatch`). Jumlah panggilan Gemini dan kredit Tavily per run tidak bertambah (diverifikasi di `e2e_mock.ts`). Kuota berita terbatas (20 laga/run), jadi laga penting (final, gugur, derbi, grup timnas) sekarang **didahulukan** (`matchImportance`).

**Validasi ketat sebelum dipakai atau disimpan ke cache** (`validateAiCtx`; sinyal yang gagal dibuang, tidak pernah diperbaiki):
1. minimal `ctxAiMinSrc` = 2 sumber web; nomor sumber yang dikutip harus ada;
2. tiap sinyal wajib membawa **kutipan asli** dari sumber (bahasa aslinya); minimal 60% kata bermaknanya harus ada di teks sumber yang dikutip, jadi karangan/terjemahan bebas ditolak;
3. rotasi "besar" wajib didukung 2 situs berbeda, kalau tidak diturunkan menjadi "sebagian";
4. skor leg 1: hanya untuk babak gugur non-final yang leg 1-nya belum tercatat; skor harus muncul di teks sumber **dan** di kutipan; arah kandang/tandang dicocokkan lewat **nama tim tuan rumah leg 1**, bukan tebakan AI;
5. derbi: kutipan harus memuat kata derbi/rivalitas dan hanya bila pasangan itu belum ada di daftar sistem.
Karena jumlah/isi sumber hanya diketahui saat panggilan, validasi dilakukan **sebelum** menulis cache; cache menyimpan hasil yang sudah bersih (`cx`), jadi pembacaan dari cache tidak perlu memvalidasi ulang (dan tidak membuang semuanya).

**Efek (kecil, terbatas, hanya menurunkan xG tim itu):**
| Sinyal AI | Pengurangan ln-xG tim | Keyakinan |
|---|---|---|
| rotasi besar / sebagian | 0,05 / 0,02 | rotasi besar: x0,96 |
| motivasi rendah, atau status juara/degradasi/lolos/gugur | 0,03 | x0,96 |
| kelelahan nyata | 0,015 | tidak berubah |
| skor leg 1 (bila sistem tak punya) | pengali leg 2 x `ctxAiLegTrust` 0,7 | tidak berubah |
| derbi (di luar daftar sistem) | tidak ada | x0,93 (sama seperti derbi sistem) |
Total penurunan per tim dibatasi `ctxAiMaxXg` = 0,06 (sekitar -5,8%); faktor keyakinan AI minimal 0,92; pengali xG gabungan seluruh konteks (sistem + AI) dijepit 0,8-1,25.

**Tidak dihitung dua kali:** bila tabel liga atau klasemen grup timnas sudah menilai motivasi tim itu (aman / sudah juara / sudah degradasi / lolos / gugur), status & motivasi dari AI diabaikan dan rotasi dihitung setengah. Skor leg 1 dari catatan sendiri (`results.legs`) selalu didahulukan dari AI. Cedera/skorsing tidak boleh dilaporkan sebagai rotasi (sudah ada di daftar absen).

**Status bukti:** efek ini **belum bisa di-backtest** (tidak ada data historis berita/rotasi di repo), jadi bobotnya sengaja kecil. Cara memantau: `calibration.json` sudah mencatat akurasi per level keyakinan; bandingkan laga bertag AI (`context.info.ai` di `public/data/history/*.json`) dengan yang tidak setelah 150+ laga. Sakelar: `AI_CONTEXT=false` (mati total, kembali persis seperti v5), `CTX_AI_SCALE=0` (label tetap tampil, xG dan keyakinan tidak berubah), `CTX_AI_SCALE=0.5` (setengah efek).

**Cakupan per jenis laga:** kelelahan (perpanjangan waktu/perjalanan dari berita, melengkapi jeda hari dari sistem), juara/degradasi pasti (status dari berita bila tabel tidak tersedia), leg kedua (skor leg 1), final (kelelahan/rotasi/status; label final tetap dari sistem), derbi (di luar daftar), grup timnas (rotasi/lolos/gugur dari berita, melengkapi hitungan klasemen). Batasan: kualitas bergantung pada hasil pencarian Tavily (5 hasil, 600 karakter per hasil); pencarian berita berbahasa Inggris paling andal, sumber berbahasa lain sering gagal lolos cek kutipan (aman: sinyal dibuang, bukan salah pakai).
