import type { Prediction } from '../shared/types.ts';
import { CFG } from './config.ts';
import { geminiGenerate } from './geminiCall.ts';
import { readCache, writeCache } from './cache.ts';
import { extractJsonArray } from './geminiStandings.ts';
import { formatHits, hasSearch, searchMatch } from './search.ts';

/** Gemini hanya menulis ringkasan teks. Semua angka berasal dari engine. Tanpa Google Search grounding (bisa berbiaya). */
export async function addAiSummaries(preds: Prediction[], key: string | undefined, model = CFG.geminiModel) {
  const out = { used: false, model, summarized: 0, error: undefined as string | undefined };
  if (!key) { out.error = 'GEMINI_API_KEY kosong'; return out; }
  const pool = [...preds].sort((a, b) => b.confidence - a.confidence).slice(0, CFG.geminiBatchSize * CFG.geminiMaxCalls); // laga paling yakin dulu
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

/** ===== Opini kedua AI: Gemini membaca hasil pencarian web (Tavily) lalu memprediksi SECARA MANDIRI (tidak diberi angka model, supaya tidak ikut-ikutan). =====
 *  Hasil dibandingkan dengan pick rumus: sepakat -> keyakinan +CFG.aiAgreeBonus, beda -> -CFG.aiDisagreePenalty (kecil; validasi lewat calibration.json). Angka peluang dari rumus TIDAK diubah. */
type Pick = '1' | 'X' | '2';
export type AiHdp = { side: '1' | '2'; line: number };
type RawOpinion = { pick: Pick; score: string | null; reason: string; style?: string; btts?: 'yes' | 'no'; ou25?: 'over' | 'under'; hdp?: AiHdp };
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
  // pasar tambahan (opsional): BTTS, Over/Under 2.5, handicap Asia (sisi + garis kelipatan 0,25 dari sudut pandang sisi itu)
  const b = String(x?.btts ?? '').trim().toLowerCase(), btts = b === 'yes' || b === 'ya' ? 'yes' : b === 'no' || b === 'tidak' ? 'no' : undefined;
  const u = String(x?.ou25 ?? '').trim().toLowerCase(), ou25 = u === 'over' ? 'over' : u === 'under' ? 'under' : undefined;
  let hdp: AiHdp | undefined;
  { const side = String(x?.hdp?.side ?? '').trim(), line = Number(x?.hdp?.line);
    if ((side === '1' || side === '2') && Number.isFinite(line) && Math.abs(line) <= 3 && Math.abs(line * 4 - Math.round(line * 4)) < 1e-9) hdp = { side, line }; }
  if (score) { const [h, a] = score.split('-').map(Number), g = h + a; // skor yang bertentangan dengan BTTS/Over-Under dibuang (pasar AI tetap dipakai)
    if ((btts === 'yes' && (h === 0 || a === 0)) || (btts === 'no' && h > 0 && a > 0) || (ou25 === 'over' && g < 3) || (ou25 === 'under' && g >= 3)) score = null; }
  const style = typeof x?.style === 'string' && x.style.trim() ? x.style.trim().slice(0, 300) : undefined; // gaya bermain/formasi (opsional, teks saja)
  return { pick: pick as Pick, score, reason, ...(style ? { style } : {}), ...(btts ? { btts } : {}), ...(ou25 ? { ou25 } : {}), ...(hdp ? { hdp } : {}) };
}
export function applyOpinion(p: Prediction, o: RawOpinion): boolean {
  const agree = o.pick === modelPick(p), adj = agree ? CFG.aiAgreeBonus : -CFG.aiDisagreePenalty;
  p.confidence = Math.max(0, Math.min(100, p.confidence + adj));
  p.confidenceLevel = p.confidence >= 50 ? 'high' : p.confidence >= 30 ? 'medium' : 'low';
  p.aiOpinion = { pick: o.pick, score: o.score, reason: o.reason, ...(o.style ? { style: o.style } : {}), ...(o.btts ? { btts: o.btts } : {}), ...(o.ou25 ? { ou25: o.ou25 } : {}), ...(o.hdp ? { hdp: o.hdp } : {}), agree, confAdj: adj };
  return agree;
}

export async function addAiOpinions(preds: Prediction[], key: string | undefined, model = CFG.geminiModel) {
  const out = { done: 0, agree: 0, error: undefined as string | undefined };
  if (!key || !CFG.useAiOpinion || !hasSearch()) return out;
  const today = new Date().toISOString().slice(0, 10), todo: Prediction[] = [];
  const pool = [...preds].sort((a, b) => b.confidence - a.confidence).slice(0, CFG.opinionBatchSize * CFG.opinionMaxCalls); // laga paling yakin dulu
  for (const p of pool) {
    const c = readCache<RawOpinion>(CFG.cacheDir, `ai_opinion_${p.id}`);
    if (c && (Date.now() - c.ts) / 3.6e6 <= CFG.opinionTtlH) { out.done++; if (applyOpinion(p, c.data)) out.agree++; } else todo.push(p);
  }
  for (let i = 0; i < todo.length; i += CFG.opinionBatchSize) {
    const batch = todo.slice(i, i + CFG.opinionBatchSize);
    const blocks: string[] = [];
    try {
      for (const p of batch) {
        const hits = await searchMatch({ id: p.id, home: p.home.name, away: p.away.name });
        if (!hits.length) continue; // tanpa sumber web -> laga ini dilewati
        blocks.push(`### id ${p.id}: ${p.home.name} (kandang) vs ${p.away.name} (tandang), ${p.league.name} (${p.league.country}), kickoff ${p.kickoff}${p.stakes ? `\nKONTEKS TABEL (dari klasemen resmi, bukan dari SUMBER): ${p.home.name} = ${p.stakes.home.label}, ${p.away.name} = ${p.stakes.away.label}; musim berjalan ${Math.round(p.stakes.phase * 100)}%` : ''}\nSUMBER:\n${formatHits(hits)}`);
      }
    } catch (e) { out.error = (e as Error).message; console.warn('[opini-web] gagal:', out.error); break; }
    if (!blocks.length) continue;
    const prompt = `Hari ini ${today}. Kamu analis sepak bola. Berdasarkan SUMBER web di bawah (berita terbaru, form, cedera/skorsing, head-to-head), beri prediksi MANDIRI untuk tiap laga.\n` +
      `pick: \"1\" = kandang (tim pertama) menang, \"X\" = seri, \"2\" = tandang (tim kedua) menang, untuk hasil 90 menit. score: skor akhir 90 menit, format \"2-1\", HARUS konsisten dengan pick. ` +
      `reason: 1-2 kalimat bahasa Indonesia berdasarkan fakta yang tertulis di SUMBER (boleh mengaitkan dengan KONTEKS TABEL bila ada: tim yang sudah aman cenderung tidak ngoyo, tim yang mengejar target butuh poin); JANGAN menebak, JANGAN memakai ingatan di luar SUMBER, JANGAN menjamin hasil. Jika SUMBER tidak cukup untuk sebuah laga, OMIT laga itu.\n` +
      `style: 1-2 kalimat bahasa Indonesia tentang pola permainan kedua tim (formasi, gaya menyerang/bertahan, pressing, serangan balik, bola mati) HANYA jika tertulis di SUMBER; jika tidak ada, isi string kosong.\n` +
      `btts: \"yes\" bila KEDUA tim diperkirakan mencetak gol, selain itu \"no\". ou25: \"over\" bila total gol 90 menit >= 3, selain itu \"under\". hdp: handicap Asia yang menurutmu paling layak, {\"side\":\"1\" (kandang) atau \"2\" (tandang),\"line\":garis dari sudut pandang tim itu, kelipatan 0.25, misal -0.5 atau +0.75}. Semuanya harus konsisten dengan pick dan score.\n` +
      `Balas HANYA JSON array: [{\"id\":number,\"pick\":\"1\"|\"X\"|\"2\",\"score\":string,\"reason\":string,\"style\":string,\"btts\":\"yes\"|\"no\",\"ou25\":\"over\"|\"under\",\"hdp\":{\"side\":\"1\"|\"2\",\"line\":number}}].\n\n${blocks.join('\n\n')}`;
    try {
      const { json: j } = await geminiGenerate(key, { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } }, model);
      const text = (j.candidates?.[0]?.content?.parts ?? []).map((x: any) => x.text ?? '').join('');
      for (const it of extractJsonArray(text)) {
        const p = batch.find(b => b.id === it?.id), o = p ? validateOpinion(it) : null; if (!p || !o) continue;
        writeCache(CFG.cacheDir, `ai_opinion_${p.id}`, o); out.done++; if (applyOpinion(p, o)) out.agree++;
      }
    } catch (e) { out.error = (e as Error).message; console.warn('[gemini-opini] gagal:', out.error); break; } // kuota habis/error -> berhenti, sisanya tanpa opini
  }
  console.log(`[gemini-opini] ${out.done}/${pool.length} laga berpendapat, ${out.agree} sepakat dengan rumus`);
  return out;
}