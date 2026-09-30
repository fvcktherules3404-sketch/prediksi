# Perubahan v6 (konteks laga + AI) dibanding zip asli `prediksi-main`

Salin file-file di zip ini ke proyek Anda dengan struktur folder yang sama (timpa yang lama). Tidak ada file yang perlu dihapus,
kecuali `e2e_mock_run.ts` di root proyek bila Anda pernah menyalinnya dari sesi sebelumnya (diganti `e2e_mock.ts`).
Tidak ada dependensi baru, tidak ada secret/env baru wajib. `package.json`, workflow, `data/`, `public/data/` TIDAK berubah.

| File | Status | Isi perubahan |
|---|---|---|
| `scripts/aiContext.ts` | BARU | validasi ketat sinyal AI, prompt konteks, prioritas laga penting |
| `scripts/context.ts` | BARU | konteks sistem (final, derbi, leg 2, kelelahan, grup timnas) + efek sinyal AI |
| `scripts/news.ts` | GANTI | prompt berita memuat permintaan konteks; validasi SEBELUM cache; laga penting didahulukan |
| `scripts/run.ts` | GANTI | petunjuk "sistem sudah tahu", konteks AI ke prediksi, metadata `aiContext` |
| `scripts/config.ts` | GANTI | kunci `ctx*` (v5) dan `ctxAi*` (v6) |
| `scripts/search.ts` | GANTI | 1 baris: kueri Tavily ditambah kata rotation/first leg/aggregate |
| `scripts/engine.ts` | GANTI | pengali & faktor keyakinan dari konteks (v5) |
| `scripts/results.ts` | GANTI | mencatat jeda antar-laga dan leg 1 (v5) |
| `scripts/stakes.ts` | GANTI | "Sudah juara" / "Sudah degradasi" pasti (v5) |
| `scripts/gemini.ts` | GANTI | perubahan kecil dari sesi sebelumnya |
| `scripts/backtest.ts` | GANTI | bagian I: uji kelelahan (v5) |
| `scripts/selftest.ts` | GANTI | tes v5 + tes konteks AI (validasi, efek, cache) |
| `shared/types.ts` | GANTI | tipe konteks, tag AI, metadata `aiContext` |
| `src/App.tsx` | GANTI | chip konteks (kunci unik, penanda AI), baris detail "Konteks dari AI" |
| `src/index.css` | GANTI | gaya chip konteks & chip AI (garis putus-putus) |
| `docs/MODEL.md` | GANTI | bagian v5 dan v6 |
| `README.md` | GANTI | ringkasan v6 |
| `e2e_mock.ts` | BARU (opsional) | uji end-to-end tanpa jaringan; JALANKAN DI SALINAN proyek (menulis ke `data/` & `public/data/`) |

Jalankan: `npm test` (selftest), `npm run typecheck`, opsional `npx tsx e2e_mock.ts` di salinan proyek.
Matikan fitur AI: `AI_CONTEXT=false`. Hanya label: `CTX_AI_SCALE=0`.
