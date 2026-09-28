# Rumus model (semua di TypeScript, tanpa AI)

1. **Rata-rata liga** (dihaluskan prior 1.45/1.15 gol, bobot 10 laga): `lgHome`, `lgAway`.
2. **Kekuatan tim** (dari klasemen): `att = 0.5·(GF venue / rata2 venue) + 0.5·(GF total / rata2 total)`; `def` serupa dari GA.
3. **Shrinkage Bayesian**: `v' = 1 + n/(n+6)·(v−1)` → sampel kecil ditarik ke rata-rata liga.
4. **Gol harapan (xG model)**: `λ_home = lgHome·att_H·def_A·(1+0.03·Δform)`, `λ_away = lgAway·att_A·def_H·(1−0.03·Δform)`; Δform = skor 5 laga terakhir (W=+1, D=0, L=−1) home − away.
5. **Poisson + Dixon-Coles** (ρ = −0.08) untuk skor 0-0, 1-0, 0-1, 1-1; matriks 11×11 dinormalisasi.
6. **Turunan**: 1X2, double chance, Over/Under 1.5/2.5/3.5, BTTS, 5 skor teratas.
7. **Handicap Asia** (kelipatan ¼): peluang win / half-win / push / half-loss / loss, fair odds `1 + P(gagal)/P(menang)`, dan garis adil (edge≈0).
8. **Keyakinan** = `100·clamp((maxP−0.34)/0.5)·(0.5+0.5·min(1, laga/10))`.
Tidak memperhitungkan cedera, susunan pemain, cuaca, atau odds bandar.
