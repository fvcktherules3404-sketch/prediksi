# Biaya: Rp0

| Komponen | Biaya | Catatan |
|---|---|---|
| GitHub Pages | Rp0 | Hosting statis. Gunakan **repository public** (Pages di repo private butuh paket berbayar). |
| GitHub Actions | Rp0 | Repo public = runner standar gratis. Job ini ±1–2 menit/hari. |
| GitHub Repository | Rp0 | Data JSON kecil (±puluhan KB/hari); history bisa dihapus kapan saja. |
| API-Football | Rp0 | Free tier ±100 request/hari. Proyek memakai **±5–30 request/hari** (2 fixture + 1 klasemen per liga) dengan cache. `apiUsage.ts` berhenti otomatis sebelum batas (cadangan 8 request). |
| Gemini API | Rp0 | Free tier, model `gemini-2.5-flash`. Maks 3 request/hari (batch 15 laga). **Tanpa** Google Search grounding. Kuota habis → "AI analysis unavailable." |
| Firebase | Tidak dipakai | Bukan dependency. Tidak ada Cloud Functions/Scheduler/Cloud Run. |
| Kartu kredit | Tidak diperlukan | Tidak ada layanan yang meminta billing pada konfigurasi default. |

## Batasan free tier (cek sendiri, bisa berubah)
- Batas dan cakupan musim free tier API-Football dapat berubah. Jika akun gratis Anda tidak mengizinkan musim berjalan, Actions akan menulis `metadata.json` status `failed` dan situs tetap menampilkan prediksi terakhir. Cek dashboard API-Football.
- Ganti provider (mis. football-data.org) cukup dengan mengubah `scripts/footballApi.ts` dan bagian parsing di `scripts/run.ts`.
