import type { Absence, Prediction } from '../shared/types.ts';
import { CFG } from './config.ts';
import { readCache, writeCache } from './cache.ts';
import { geminiGenerate } from './geminiCall.ts';
import { extractJsonArray } from './geminiStandings.ts';
import { formatHits, hasSearch, searchMatch, type WebHit } from './search.ts';
import { CTX_PROMPT, matchImportance, validateAiCtx, type AiCtx, type CtxHint } from './aiContext.ts';
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

/** Simpanan absen per LAGA (bukan per batch), hanya ditulis dari hasil Gemini yang SEGAR. Dipakai sebagai cadangan bila run berikutnya tidak menemukan berita
 *  (pencarian gagal/kosong, Gemini gagal, kuota habis), maksimal CFG.absKeepH jam. Hasil kosong dari run yang menemukan berita DITERIMA (pemain dianggap sembuh). */
const absKey = (id: number) => `absfx_${id}`;
const cleanAbs = (l: any): Absence[] => (Array.isArray(l) ? l : []).map(validateAbsence).filter((a): a is Absence => !!a).slice(0, 8);
export function saveAbsFx(dir: string, id: number, home: any, away: any, cx: any) { try { writeCache(dir, absKey(id), { home: cleanAbs(home), away: cleanAbs(away), cx: cx ?? null }); } catch { /* cadangan saja */ } }
export function loadAbsFx(dir: string, id: number, maxH = CFG.absKeepH, now = Date.now()): { home: Absence[]; away: Absence[]; cx: AiCtx | null } | null {
  const c = readCache<any>(dir, absKey(id)); if (!c || !c.data || !(now - c.ts <= maxH * 3.6e6)) return null;
  return { home: cleanAbs(c.data.home), away: cleanAbs(c.data.away), cx: c.data.cx && Array.isArray(c.data.cx.sigs) ? c.data.cx as AiCtx : null };
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

/** Berita cedera/skorsing/kondisi skuad: hasil pencarian web (Tavily) ditempel ke Gemini sebagai SUMBER, lalu Gemini meringkasnya
 *  ke JSON per laga. Laga tanpa hasil pencarian dilewati (tidak ada panggilan Gemini). Tervalidasi dan di-cache. */
export async function aiAbsences(key: string, fixtures: any[], hints: Map<number, { home: Absence[]; away: Absence[] }>, ctxHints: Map<number, CtxHint> = new Map()) {
  const out = new Map<number, { home: Absence[]; away: Absence[] }>(), ctxOut = new Map<number, AiCtx>(); let nChecked = 0; const today = new Date().toISOString().slice(0, 10);
  let calls = 0, err: string | undefined;
  const reuse = () => { // laga yang tidak diperiksa ulang di run ini -> pakai hasil run sebelumnya (<= absKeepH jam)
    let n = 0;
    for (const f of fixtures) { const id = f.fixture.id; if (out.has(id)) continue; const o = loadAbsFx(CFG.cacheDir, id); if (!o) continue; out.set(id, { home: o.home, away: o.away }); if (CFG.ctxAi && o.cx) { ctxOut.set(id, o.cx); nChecked++; } n++; }
    if (n) console.log(`[gemini-berita] ${n} laga memakai data run sebelumnya (berita baru tidak ditemukan)`);
  };
  if (!hasSearch()) { reuse(); return { map: out, ctx: ctxOut, nCtx: nChecked, error: 'TAVILY_API_KEY kosong' as string | undefined }; }
  // v6: kuota terbatas -> laga penting (final, gugur, derbi, grup timnas) didahulukan; urutan sama untuk laga sederajat (sort stabil)
  const pool = (CFG.ctxAi ? [...fixtures].sort((a, b) => matchImportance(b) - matchImportance(a)) : fixtures).slice(0, CFG.newsBatchSize * CFG.newsMaxCalls);
  for (let i = 0; i < pool.length && calls < CFG.newsMaxCalls; i += CFG.newsBatchSize) {
    const batch = pool.slice(i, i + CFG.newsBatchSize);
    const ck = `news2_${today}_${batch.map((f: any) => f.fixture.id).join('-')}`, c = readCache<any[]>(CFG.cacheDir, ck);
    let arr: any[]; const hitsById = new Map<number, WebHit[]>();
    if (c && (Date.now() - c.ts) / 3.6e6 <= CFG.newsTtlH) arr = c.data;
    else {
      const blocks: string[] = [];
      try {
        for (const f of batch) {
          const hits = await searchMatch({ id: f.fixture.id, home: f.teams.home.name, away: f.teams.away.name });
          if (!hits.length) continue; // tanpa sumber web -> laga ini dilewati
          hitsById.set(f.fixture.id, hits);
          const h = hints.get(f.fixture.id) as any, hi = (t: number) => (h?._m?.get(t) ?? []).map((a: Absence) => a.name).join(', ') || '-';
          blocks.push(`### id ${f.fixture.id}: ${f.teams.home.name} (kandang) vs ${f.teams.away.name} (tandang), ${f.league.name}, ${f.fixture.date}\n` +
            `Daftar API (belum terverifikasi) kandang: ${hi(f.teams.home.id)}; tandang: ${hi(f.teams.away.id)}${CFG.ctxAi && ctxHints.get(f.fixture.id) ? `\n${ctxHints.get(f.fixture.id)!.text}` : ''}\nSUMBER:\n${formatHits(hits)}`);
        }
      } catch (e) { err = (e as Error).message; console.warn('[berita-web] gagal:', err); break; }
      if (!blocks.length) continue;
      calls++;
      const prompt = `Hari ini ${today}. Dari SUMBER web di bawah (berita terbaru), ekstrak pemain yang cedera, diskors, atau diragukan tampil untuk tiap pertandingan.\n\n${blocks.join('\n\n')}\n\n` +
        `Untuk tiap pemain absen berikan: name, pos (GK|DEF|MID|FWD), role (\"key\" = bintang/top skor/kiper utama/kapten yang hampir pasti starter; \"starter\" = starter reguler; \"rotation\" = pelapis), status (\"out\" = pasti absen, \"doubt\" = diragukan), reason (singkat).\n` +
        `ATURAN KERAS: gunakan HANYA informasi yang tertulis di SUMBER laga tersebut; JANGAN menebak atau memakai ingatan lama; jika SUMBER tidak menyebut pemain absen, beri array kosong. Daftar API di atas hanya petunjuk, sertakan hanya bila SUMBER mengonfirmasi. ` +
        (CFG.ctxAi ? CTX_PROMPT + `\nBalas HANYA JSON array: [{\"id\":number,\"home\":[{\"name\":string,\"pos\":string,\"role\":string,\"status\":string,\"reason\":string}],\"away\":[...],\"ctx\":{\"sig\":[{\"team\":\"home\"|\"away\",\"kind\":string,\"value\":string,\"s\":[number],\"ev\":string}],\"leg1\":{\"home_team\":string,\"score\":string,\"s\":[number],\"ev\":string}|null,\"derby\":{\"s\":[number],\"ev\":string}|null}}]`
        : `Balas HANYA JSON array: [{\"id\":number,\"home\":[{\"name\":string,\"pos\":string,\"role\":string,\"status\":string,\"reason\":string}],\"away\":[...]}]`);
      try {
        const { json: j } = await geminiGenerate(key, { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } });
        // v6: konteks AI DIVALIDASI SEKARANG (jumlah & isi sumber web hanya diketahui saat panggilan ini) lalu hasil yang sudah bersih yang disimpan ke cache.
        //     Saat dibaca dari cache tidak ada validasi ulang: `cx` sudah final. (Menyimpan mentahan lalu memvalidasi ulang dari cache akan membuang semuanya karena sumber tak diketahui.)
        arr = extractJsonArray((j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('')).map((it: any) => {
          const fx = batch.find((f: any) => f.fixture.id === it?.id), hits = hitsById.get(it?.id) ?? [];
          const cx = CFG.ctxAi && fx ? validateAiCtx(it?.ctx, hits, { home: fx.teams.home.name, away: fx.teams.away.name, round: fx.league.round, hasLeg1: ctxHints.get(fx.fixture.id)?.hasLeg1 }) : null;
          return { id: it?.id, home: it?.home, away: it?.away, cx };
        });
        writeCache(CFG.cacheDir, ck, arr);
        for (const it of arr) if (batch.some((f: any) => f.fixture.id === it?.id)) saveAbsFx(CFG.cacheDir, it.id, it.home, it.away, it.cx); // hanya hasil segar (bukan hasil baca cache) supaya umur data tidak diperpanjang
      } catch (e) { err = (e as Error).message; console.warn('[gemini-berita] gagal:', err); if (/HTTP 429|HTTP 404/.test(err)) break; continue; }
    }
    for (const it of arr) {
      const fx = batch.find((f: any) => f.fixture.id === it?.id); if (!fx) continue;
      const clean = (l: any) => (Array.isArray(l) ? l : []).map(validateAbsence).filter((a): a is Absence => !!a).slice(0, 8);
      out.set(fx.fixture.id, { home: clean(it.home), away: clean(it.away) });
      if (CFG.ctxAi && it.cx && typeof it.cx === 'object' && Array.isArray(it.cx.sigs)) { ctxOut.set(fx.fixture.id, it.cx as AiCtx); nChecked++; }
    }
  }
  reuse();
  console.log(`[gemini-berita] ${out.size}/${pool.length} laga, ${calls} panggilan${CFG.ctxAi ? `, konteks AI ${nChecked} laga diperiksa` : ''}`);
  return { map: out, ctx: ctxOut, nCtx: nChecked, error: err };
}

/** Kumpulkan absensi: API-Football (murah) + Gemini berita (opsional). Return per fixture id. */
export async function collectAbsences(api: FootballApi, fixtures: any[], dates: string[], gKey?: string, ctxHints?: Map<number, CtxHint>): Promise<{ map: AbsMap; nApi: number; nAi: number; error?: string; ctx: Map<number, AiCtx>; nCtx: number }> {
  const hints = CFG.useInjuries ? await apiInjuries(api, dates) : new Map();
  const ai = gKey && CFG.useNews && fixtures.length ? await aiAbsences(gKey, fixtures, hints, ctxHints) : { map: new Map(), ctx: new Map<number, AiCtx>(), nCtx: 0, error: undefined as string | undefined };
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
  return { map, nApi, nAi, error: ai.error, ctx: ai.ctx, nCtx: ai.nCtx };
}