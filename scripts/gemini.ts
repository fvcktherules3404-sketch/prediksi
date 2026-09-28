import type { Prediction } from '../shared/types.ts';
import { CFG } from './config.ts';
import { geminiGenerate } from './geminiCall.ts';
import { readCache, writeCache } from './cache.ts';
import { extractJsonArray } from './geminiStandings.ts';

/** Gemini hanya menulis ringkasan teks. Semua angka berasal dari engine. Tanpa Google Search grounding (bisa berbiaya). */
export async function addAiSummaries(preds: Prediction[], key: string | undefined, model = CFG.geminiModel) {
  const out = { used: false, model, summarized: 0, error: undefined as string | undefined };
  if (!key) { out.error = 'GEMINI_API_KEY kosong'; return out; }
  const pool = [...preds].sort((a, b) => a.timestamp - b.timestamp).slice(0, CFG.geminiBatchSize * CFG.geminiMaxCalls);
  for (let i = 0; i < pool.length; i += CFG.geminiBatchSize) {
    const batch = pool.slice(i, i + CFG.geminiBatchSize);
    const payload = batch.map(p => ({
      id: p.id, liga: p.league.name, kandang: p.home.name, tandang: p.away.name,
      peringkat: [p.home.rank, p.away.rank], form: [p.home.form, p.away.form], xg: [p.xg.home, p.xg.away],
      peluang_1x2: [p.probs.home, p.probs.draw, p.probs.away], over25: p.ou[1].over, btts: p.btts.yes,
      absen_kandang: (p.absences?.home ?? []).map(a => `${a.name} (${a.pos}, ${a.status})`), absen_tandang: (p.absences?.away ?? []).map(a => `${a.name} (${a.pos}, ${a.status})`), penyesuaian_xg_absen: p.absences?.adj, skor_teratas: p.topScores[0].score, pick: p.picks.result, handicap_adil: p.fairHandicap,
    }));
    const prompt = `Kamu analis sepak bola. Untuk setiap pertandingan di bawah, tulis ringkasan 2 kalimat bahasa Indonesia yang menjelaskan mengapa model statistik memberi angka tersebut (kekuatan serang/bertahan, form, peringkat, dan pengaruh absen jika ada), dan jelaskan mengapa pick 'pick' (termasuk bila Seri) masuk akal. ` +
      `JANGAN mengubah atau menghitung ulang angka, Boleh menyebut pemain absen HANYA dari field absen_kandang/absen_tandang (jangan menambah nama lain, jangan menebak cedera), JANGAN menjamin hasil. ` +
      `Balas HANYA JSON array: [{"id":number,"summary":string}].\n\n${JSON.stringify(payload)}`;
    let ok = false;
    try {
      const { json: j, model: used } = await geminiGenerate(key, { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.4 } }, model);
      out.model = used;
      const arr = JSON.parse((j.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]').replace(/```json|```/g, ''));
      for (const it of arr) { const p = batch.find(b => b.id === it.id); if (p && typeof it.summary === 'string' && it.summary.trim()) { p.aiSummary = it.summary.trim(); out.summarized++; } }
      out.used = true; ok = true;
    } catch (e) { out.error = (e as Error).message; console.warn('[gemini] gagal:', out.error); }
    if (!ok) break; // kuota habis / error -> berhenti, sisanya tetap "AI analysis unavailable."
  }
  return out;
}

/** ===== Opini kedua AI: Gemini + Google Search memprediksi SECARA MANDIRI (tidak diberi angka model, supaya tidak ikut-ikutan). =====
 *  Hasil dibandingkan dengan pick rumus: sepakat -> keyakinan +5, beda -> -12. Angka peluang dari rumus TIDAK diubah. */
type Pick = '1' | 'X' | '2';
type RawOpinion = { pick: Pick; score: string | null; reason: string };
export const modelPick = (p: Prediction): Pick => p.picks.pick1x2 ?? (p.probs.home >= p.probs.draw && p.probs.home >= p.probs.away ? '1' : p.probs.away >= p.probs.draw ? '2' : 'X');

/** Validasi satu opini AI; null bila tidak masuk akal (dibuang, tidak pernah diperbaiki). Skor yang bertentangan dengan pick dibuang saja. */
export function validateOpinion(x: any): RawOpinion | null {
  const pick = String(x?.pick ?? '').trim().toUpperCase();
  if (pick !== '1' && pick !== 'X' && pick !== '2') return null;
  const reason = typeof x?.reason === 'string' ? x.reason.trim().slice(0, 300) : '';
  if (!reason) return null;
  let score: string | null = null;
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(String(x?.score ?? '').trim());
  if (m) { const h = Number(m[1]), a = Number(m[2]); if ((pick === '1' && h > a) || (pick === 'X' && h === a) || (pick === '2' && h < a)) score = `${h}-${a}`; }
  return { pick: pick as Pick, score, reason };
}
export function applyOpinion(p: Prediction, o: RawOpinion): boolean {
  const agree = o.pick === modelPick(p), adj = agree ? 5 : -12;
  p.confidence = Math.max(0, Math.min(100, p.confidence + adj));
  p.confidenceLevel = p.confidence >= 50 ? 'high' : p.confidence >= 30 ? 'medium' : 'low';
  p.aiOpinion = { pick: o.pick, score: o.score, reason: o.reason, agree, confAdj: adj };
  return agree;
}

export async function addAiOpinions(preds: Prediction[], key: string | undefined, model = CFG.geminiModel) {
  const out = { done: 0, agree: 0, error: undefined as string | undefined };
  if (!key || !CFG.useAiOpinion) return out;
  const today = new Date().toISOString().slice(0, 10), todo: Prediction[] = [];
  const pool = [...preds].sort((a, b) => a.timestamp - b.timestamp).slice(0, CFG.opinionBatchSize * CFG.opinionMaxCalls);
  for (const p of pool) {
    const c = readCache<RawOpinion>(CFG.cacheDir, `ai_opinion_${p.id}`);
    if (c && (Date.now() - c.ts) / 3.6e6 <= CFG.opinionTtlH) { out.done++; if (applyOpinion(p, c.data)) out.agree++; } else todo.push(p);
  }
  for (let i = 0; i < todo.length; i += CFG.opinionBatchSize) {
    const batch = todo.slice(i, i + CFG.opinionBatchSize);
    const list = batch.map(p => ({ id: p.id, liga: p.league.name, negara: p.league.country, kandang: p.home.name, tandang: p.away.name, kickoff: p.kickoff }));
    const prompt = `Hari ini ${today}. Kamu analis sepak bola. Cari di web (berita terbaru, form, cedera/skorsing, head-to-head) lalu beri prediksi MANDIRI untuk tiap laga berikut.\n` +
      `pick: "1" = kandang (tim pertama) menang, "X" = seri, "2" = tandang (tim kedua) menang, untuk hasil 90 menit. score: skor akhir 90 menit, format "2-1", HARUS konsisten dengan pick. ` +
      `reason: 1-2 kalimat bahasa Indonesia berdasarkan fakta yang benar-benar kamu temukan; JANGAN menebak, JANGAN menjamin hasil. Jika tidak menemukan informasi cukup untuk sebuah laga, OMIT laga itu.\n` +
      `Balas HANYA JSON array: [{"id":number,"pick":"1"|"X"|"2","score":string,"reason":string}].\n\n${JSON.stringify(list)}`;
    try {
      const { json: j } = await geminiGenerate(key, { contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.2 } }, model);
      const cand = j.candidates?.[0];
      if (!cand?.groundingMetadata?.groundingChunks?.length) throw new Error('tanpa grounding (tidak ada sumber web) -> dibuang');
      const text = (cand.content?.parts ?? []).map((x: any) => x.text ?? '').join('');
      for (const it of extractJsonArray(text)) {
        const p = batch.find(b => b.id === it?.id), o = p ? validateOpinion(it) : null; if (!p || !o) continue;
        writeCache(CFG.cacheDir, `ai_opinion_${p.id}`, o); out.done++; if (applyOpinion(p, o)) out.agree++;
      }
    } catch (e) { out.error = (e as Error).message; console.warn('[gemini-opini] gagal:', out.error); break; } // kuota habis/error -> berhenti, sisanya tanpa opini
  }
  console.log(`[gemini-opini] ${out.done}/${pool.length} laga berpendapat, ${out.agree} sepakat dengan rumus`);
  return out;
}