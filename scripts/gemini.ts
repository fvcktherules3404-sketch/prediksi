import type { Prediction } from '../shared/types.ts';
import { CFG } from './config.ts';

/** Gemini hanya menulis ringkasan teks. Semua angka berasal dari engine. Tanpa Google Search grounding (bisa berbiaya). */
export async function addAiSummaries(preds: Prediction[], key: string | undefined, model = CFG.geminiModel) {
  const out = { used: false, model, summarized: 0, error: undefined as string | undefined };
  if (!key) { out.error = 'GEMINI_API_KEY kosong'; return out; }
  const pool = [...preds].sort((a, b) => b.confidence - a.confidence).slice(0, CFG.geminiBatchSize * CFG.geminiMaxCalls);
  for (let i = 0; i < pool.length; i += CFG.geminiBatchSize) {
    const batch = pool.slice(i, i + CFG.geminiBatchSize);
    const payload = batch.map(p => ({
      id: p.id, liga: p.league.name, kandang: p.home.name, tandang: p.away.name,
      peringkat: [p.home.rank, p.away.rank], form: [p.home.form, p.away.form], xg: [p.xg.home, p.xg.away],
      peluang_1x2: [p.probs.home, p.probs.draw, p.probs.away], over25: p.ou[1].over, btts: p.btts.yes,
      skor_teratas: p.topScores[0].score, handicap_adil: p.fairHandicap,
    }));
    const prompt = `Kamu analis sepak bola. Untuk setiap pertandingan di bawah, tulis ringkasan 2 kalimat bahasa Indonesia yang menjelaskan mengapa model statistik memberi angka tersebut (kekuatan serang/bertahan, form, peringkat). ` +
      `JANGAN mengubah atau menghitung ulang angka, JANGAN menyebut cedera/berita (kamu tidak punya datanya), JANGAN menjamin hasil. ` +
      `Balas HANYA JSON array: [{"id":number,"summary":string}].\n\n${JSON.stringify(payload)}`;
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.4 } }),
        });
        if (res.status === 503) { await new Promise(r => setTimeout(r, 5000)); continue; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j: any = await res.json();
        const arr = JSON.parse((j.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]').replace(/```json|```/g, ''));
        for (const it of arr) { const p = batch.find(b => b.id === it.id); if (p && typeof it.summary === 'string' && it.summary.trim()) { p.aiSummary = it.summary.trim(); out.summarized++; } }
        out.used = true; ok = true;
      } catch (e) { out.error = (e as Error).message; console.warn('[gemini] gagal:', out.error); break; }
    }
    if (!ok) break; // kuota habis / error -> berhenti, sisanya tetap "AI analysis unavailable."
  }
  return out;
}
