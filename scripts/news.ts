import type { Absence, Prediction } from '../shared/types.ts';
import { CFG } from './config.ts';
import { readCache, writeCache } from './cache.ts';
import { geminiGenerate } from './geminiCall.ts';
import { extractJsonArray } from './geminiStandings.ts';
import type { FootballApi } from './footballApi.ts';

export type AbsMap = Map<number, NonNullable<Prediction['absences']>>;
const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z\s]/g, ' ').trim();
const last = (s: string) => norm(s).split(/\s+/).filter(Boolean).pop() ?? '';

/** Validasi ketat satu entri absen dari AI. Nilai tak dikenal dibuang/diturunkan ke yang paling konservatif. */
export function validateAbsence(x: any): Absence | null {
  const name = typeof x?.name === 'string' ? x.name.trim().slice(0, 40) : ''; if (name.length < 3) return null;
  const pos = ['GK', 'DEF', 'MID', 'FWD'].includes(x.pos) ? x.pos : '?';
  const role = ['key', 'starter', 'rotation'].includes(x.role) ? x.role : 'rotation';
  const status = x.status === 'doubt' ? 'doubt' : 'out';
  return { name, pos, role, status, reason: typeof x.reason === 'string' ? x.reason.slice(0, 40) : undefined };
}
/** Gabung daftar API (tanpa posisi/peran) dengan AI (posisi & peran). Nama yang sama -> pakai versi AI. */
export function mergeAbsences(api: Absence[], ai: Absence[]): Absence[] {
  const out = [...ai];
  for (const a of api) if (!out.some(b => last(b.name) === last(a.name))) out.push(a);
  return out.slice(0, 10);
}

/** Absen dari endpoint injuries API-Football: 1 request per tanggal (bukan per laga). */
export async function apiInjuries(api: FootballApi, dates: string[]): Promise<Map<number, { home: Absence[]; away: Absence[] }>> {
  const byFx = new Map<number, Map<number, Absence[]>>(); let got = 0;
  for (const d of dates) {
    const r = await api.get('injuries', { date: d }, CFG.newsTtlH); if (!r) continue;
    for (const x of r.data) {
      const fid = x?.fixture?.id, tid = x?.team?.id, name = x?.player?.name; if (!fid || !tid || !name) continue;
      const doubt = /questionable/i.test(x.player?.type ?? '');
      const m = byFx.get(fid) ?? byFx.set(fid, new Map()).get(fid)!; const l = m.get(tid) ?? m.set(tid, []).get(tid)!;
      if (!l.some(a => a.name === name)) { l.push({ name, pos: '?', role: 'unknown', status: doubt ? 'doubt' : 'out', reason: x.player?.reason }); got++; }
    }
  }
  console.log(`[injuries] API-Football: ${got} pemain absen`);
  const out = new Map<number, { home: Absence[]; away: Absence[] }>();
  for (const [fid, m] of byFx) out.set(fid, { home: [], away: [] } as any), (out.get(fid) as any)._m = m;
  return out;
}

/** Gemini + Google Search: berita cedera/skorsing/kondisi skuad terbaru, dikelompokkan per laga. Wajib ter-grounding, tervalidasi, di-cache. */
export async function aiAbsences(key: string, fixtures: any[], hints: Map<number, { home: Absence[]; away: Absence[] }>) {
  const out = new Map<number, { home: Absence[]; away: Absence[] }>(); const today = new Date().toISOString().slice(0, 10);
  let calls = 0, err: string | undefined;
  const pool = fixtures.slice(0, CFG.newsBatchSize * CFG.newsMaxCalls);
  for (let i = 0; i < pool.length && calls < CFG.newsMaxCalls; i += CFG.newsBatchSize) {
    const batch = pool.slice(i, i + CFG.newsBatchSize);
    const ck = `news_${today}_${batch.map((f: any) => f.fixture.id).join('-')}`, c = readCache<any[]>(CFG.cacheDir, ck);
    let arr: any[];
    if (c && (Date.now() - c.ts) / 3.6e6 <= CFG.newsTtlH) arr = c.data;
    else {
      calls++;
      const list = batch.map((f: any) => {
        const h = hints.get(f.fixture.id) as any, hi = (t: number) => (h?._m?.get(t) ?? []).map((a: Absence) => a.name).join(', ') || '-';
        return `- id ${f.fixture.id}: ${f.teams.home.name} (kandang) vs ${f.teams.away.name} (tandang), ${f.league.name}, ${f.fixture.date}. Daftar API (belum terverifikasi) kandang: ${hi(f.teams.home.id)}; tandang: ${hi(f.teams.away.id)}`;
      }).join('\n');
      const prompt = `Hari ini ${today}. Cari di web berita TERBARU (maks 7 hari terakhir) tentang pemain cedera, skorsing, atau diragukan tampil untuk pertandingan berikut, termasuk perkiraan susunan pemain bila ada:\n${list}\n\n` +
        `Untuk tiap pemain absen berikan: name, pos (GK|DEF|MID|FWD), role ("key" = bintang/top skor/kiper utama/kapten yang hampir pasti starter; "starter" = starter reguler; "rotation" = pelapis), status ("out" = pasti absen, "doubt" = diragukan), reason (singkat).\n` +
        `ATURAN KERAS: hanya pemain yang disebut jelas di sumber; JANGAN menebak atau memakai ingatan lama; jika tidak ada berita, beri array kosong. Daftar API di atas boleh dipakai sebagai petunjuk pencarian tetapi hanya sertakan bila sumber web mengonfirmasi. ` +
        `Balas HANYA JSON array: [{"id":number,"home":[{"name":string,"pos":string,"role":string,"status":string,"reason":string}],"away":[...]}]`;
      try {
        const { json: j } = await geminiGenerate(key, { contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0 } });
        const cand = j.candidates?.[0];
        if (!cand?.groundingMetadata?.groundingChunks?.length) throw new Error('tanpa grounding -> dibuang');
        arr = extractJsonArray((cand.content?.parts ?? []).map((p: any) => p.text ?? '').join(''));
        writeCache(CFG.cacheDir, ck, arr);
      } catch (e) { err = (e as Error).message; console.warn('[gemini-berita] gagal:', err); if (/HTTP 429|HTTP 404/.test(err)) break; continue; }
    }
    for (const it of arr) {
      const fx = batch.find((f: any) => f.fixture.id === it?.id); if (!fx) continue;
      const clean = (l: any) => (Array.isArray(l) ? l : []).map(validateAbsence).filter((a): a is Absence => !!a).slice(0, 8);
      out.set(fx.fixture.id, { home: clean(it.home), away: clean(it.away) });
    }
  }
  console.log(`[gemini-berita] ${out.size}/${pool.length} laga, ${calls} panggilan`);
  return { map: out, error: err };
}

/** Kumpulkan absensi: API-Football (murah) + Gemini berita (opsional). Return per fixture id. */
export async function collectAbsences(api: FootballApi, fixtures: any[], dates: string[], gKey?: string): Promise<{ map: AbsMap; nApi: number; nAi: number; error?: string }> {
  const hints = CFG.useInjuries ? await apiInjuries(api, dates) : new Map();
  const ai = gKey && CFG.useNews && fixtures.length ? await aiAbsences(gKey, fixtures, hints) : { map: new Map(), error: undefined as string | undefined };
  const map: AbsMap = new Map(); let nApi = 0, nAi = 0;
  for (const f of fixtures) {
    const id = f.fixture.id, h = hints.get(id) as any, a = ai.map.get(id);
    const apiH: Absence[] = h?._m?.get(f.teams.home.id) ?? [], apiA: Absence[] = h?._m?.get(f.teams.away.id) ?? [];
    if (!a && !apiH.length && !apiA.length) continue;
    // Jika AI sudah memeriksa laga ini, entri API yang tidak dikonfirmasi AI tetap ikut tetapi berbobot kecil (role 'unknown').
    const home = mergeAbsences(apiH, a?.home ?? []), away = mergeAbsences(apiA, a?.away ?? []);
    if (!home.length && !away.length && !a) continue;
    const source = a && (apiH.length || apiA.length) ? 'both' : a ? 'ai' : 'api';
    if (a) nAi++; else nApi++;
    map.set(id, { home, away, source, checked: !!a });
  }
  return { map, nApi, nAi, error: ai.error };
}
