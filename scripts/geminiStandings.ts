import { CFG } from './config.ts';
import { readCache, writeCache } from './cache.ts';
import { tokens, type Row } from './standings.ts';

const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** Validasi ketat satu baris hasil Gemini. Return null bila tidak masuk akal (dibuang, tidak pernah diperbaiki/ditebak). */
export function validateAiRow(x: any, ownPlayed = 0): Omit<Row, 'team'> | null {
  const hp = int(x?.home?.played), hg = int(x?.home?.gf), hga = int(x?.home?.ga), ap = int(x?.away?.played), ag = int(x?.away?.gf), aga = int(x?.away?.ga);
  if ([hp, hg, hga, ap, ag, aga].some(v => v === null)) return null;
  const played = hp! + ap!;
  if (played < 1 || played > 60 || Math.abs(hp! - ap!) > 2 || played < ownPlayed) return null;
  if ((hg! + ag!) / played > 4.5 || (hga! + aga!) / played > 4.5) return null;
  if ((hp! > 0 && hg! / hp! > 7) || (ap! > 0 && ag! / ap! > 7)) return null;
  const form = typeof x.form === 'string' && /^[WDLwdl]{1,5}$/.test(x.form) ? x.form.toUpperCase() : null;
  const rank = int(x.rank) && x.rank >= 1 && x.rank <= 40 ? x.rank : null;
  const sp = (p: number, f: number, a: number) => ({ played: p, goals: { for: f, against: a } });
  return { rank, form, all: sp(played, hg! + ag!, hga! + aga!), home: sp(hp!, hg!, hga!), away: sp(ap!, ag!, aga!), source: 'ai' };
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
/** Ekstrak array JSON dari teks bebas (dengan grounding, mode JSON murni tidak didukung). */
export function extractJsonArray(text: string): any[] { const i = text.indexOf('['), j = text.lastIndexOf(']'); if (i < 0 || j <= i) return []; try { const a = JSON.parse(text.slice(i, j + 1)); return Array.isArray(a) ? a : []; } catch { return []; } }

/** Gemini + Google Search grounding mencari klasemen tim yang belum punya data. Hasil hanya dipakai jika:
 *  (1) respons benar-benar ter-grounding (ada sumber web), (2) lolos validasi angka, (3) jumlah laga tidak menyimpang dari tim lain.
 *  Semua baris diberi source='ai' (ditandai "belum terverifikasi" di UI, keyakinan diturunkan). */
export async function aiStandings(key: string, lg: { id: number; name: string; country?: string; season: number }, teams: { id: number; name: string }[], own: Map<number, Row>, model = CFG.geminiModel): Promise<Map<number, Row>> {
  const out = new Map<number, Row>(); const today = new Date().toISOString().slice(0, 10);
  const ck = `ai_standings_${lg.id}_${lg.season}_${teams.map(t => t.id).sort((a, b) => a - b).join('-')}`;
  const c = readCache<Row[]>(CFG.cacheDir, ck);
  if (c && (Date.now() - c.ts) / 3.6e6 <= CFG.standingsTtlH) { for (const r of c.data) out.set(r.team.id, r); return out; }
  const prompt = `Hari ini ${today}. Cari klasemen ${lg.name}${lg.country ? ` (${lg.country})` : ''} musim ${lg.season} yang sedang berjalan di web, lalu berikan statistik HANYA untuk tim berikut: ${teams.map(t => t.name).join('; ')}.\n` +
    `Untuk tiap tim: laga/gol kandang dan tandang terpisah (home & away: played, gf = gol memasukkan, ga = gol kebobolan), form 5 laga terakhir (huruf W/D/L, terbaru di akhir), peringkat.\n` +
    `ATURAN: hanya angka yang benar-benar tertulis di sumber; JANGAN menebak atau menghitung dari ingatan. Jika sebuah tim tidak ditemukan atau angkanya tidak jelas, OMIT tim itu. Salin nama tim persis seperti di daftar. ` +
    `Balas HANYA JSON array: [{"team":string,"rank":number|null,"form":string|null,"home":{"played":number,"gf":number,"ga":number},"away":{"played":number,"gf":number,"ga":number}}]`;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0 } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j: any = await res.json(), cand = j.candidates?.[0];
    if (!cand?.groundingMetadata?.groundingChunks?.length) throw new Error('tanpa grounding (tidak ada sumber web) -> dibuang');
    const text = (cand.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
    const good: { team: { id: number; name: string }; r: Omit<Row, 'team'> }[] = [];
    for (const it of extractJsonArray(text)) {
      const t = teams.find(x => tokens(x.name).join(' ') === tokens(String(it?.team ?? '')).join(' ')); if (!t) continue;
      const r = validateAiRow(it, own.get(t.id)?.all.played ?? 0); if (r) good.push({ team: t, r });
    }
    const med = good.length >= 3 ? median(good.map(g => g.r.all.played)) : null; // semua tim di 1 liga harus punya jumlah laga berdekatan
    const rows: Row[] = [];
    for (const g of good) if (med === null || Math.abs(g.r.all.played - med) <= 3) rows.push({ team: g.team, ...g.r });
    for (const r of rows) out.set(r.team.id, r);
    if (rows.length) writeCache(CFG.cacheDir, ck, rows);
    console.log(`[gemini-klasemen] ${lg.name}: ${rows.length}/${teams.length} tim lolos validasi`);
  } catch (e) { console.warn(`[gemini-klasemen] ${lg.name} gagal: ${(e as Error).message}`); }
  return out;
}
