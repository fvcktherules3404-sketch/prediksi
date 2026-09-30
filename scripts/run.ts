import fs from 'node:fs';
import path from 'node:path';
import type { Prediction, PredictionsFile, Metadata } from '../shared/types.ts';
import { CFG } from './config.ts';
import { ApiUsage } from './apiUsage.ts';
import { FootballApi, readApiKeys } from './footballApi.ts';
import { buildPrediction, leagueAverages } from './engine.ts';
import { addAiSummaries, addAiOpinions } from './gemini.ts';
import { loadResults, saveResults, collectResults, ownRows } from './results.ts';
import { fdStandings } from './footballData.ts';
import { collectAbsences } from './news.ts';
import { aiStandings } from './geminiStandings.ts';
import { matchTeams, type Row } from './standings.ts';
import { fetchClubElo, fetchNationalElo, matchElo, clubCountry, clubEloCovered } from './elo.ts';
import { collectOdds } from './odds.ts';
import { evaluate, activeCalibration } from './evaluate.ts';
import { pruneCache } from './cache.ts';
import { tableCtx, seasonPhase, type TableCtx } from './stakes.ts';
import { pickHeadline } from './headline.ts';
import { buildContext, parseGroups, findGroup, isKnockoutRound, legKey, type GroupTable } from './context.ts';
import { ctxHint, tableKnown, aiCtxCount, type AiCtx, type CtxHint } from './aiContext.ts';
import { isSeniorMen } from './filter.ts';
import { marketElo } from './engine.ts';
import type { Slot } from '../shared/types.ts';

const H = 3.6e6, DAY = 24 * H;
/** Dua sesi per hari (WIB). Batas terakhir (06:00 atau 21:00) yang <= waktu eksekusi AKTUAL menentukan sesi (cron GitHub boleh telat).
 *  pagi : 06:00 -> 20:59:59   |   malam : 21:00 -> 05:59:59 (besoknya).  dayStart = 06:00 WIB awal "hari prediksi". */
export function computeWindow(nowMs: number) {
  const off = CFG.tzOffsetHours * H, { pagi, malam } = CFG.slotHoursWIB;
  const wib = nowMs + off, dayMs = Math.floor(wib / DAY) * DAY, hod = (wib - dayMs) / H;
  let slot: Slot, baseWib: number, endWib: number, dayStartWib: number;
  if (hod >= malam) { slot = 'malam'; baseWib = dayMs + malam * H; endWib = dayMs + DAY + pagi * H; dayStartWib = dayMs + pagi * H; }
  else if (hod >= pagi) { slot = 'pagi'; baseWib = dayMs + pagi * H; endWib = dayMs + malam * H; dayStartWib = baseWib; }
  else { slot = 'malam'; baseWib = dayMs - DAY + malam * H; endWib = dayMs + pagi * H; dayStartWib = dayMs - DAY + pagi * H; }
  const start = baseWib - off, end = endWib - off - 1000, dayStart = dayStartWib - off;
  const dateA = new Date(baseWib).toISOString().slice(0, 10), dateB = new Date(baseWib + DAY).toISOString().slice(0, 10);
  // endAll: sesi pagi juga membuat PRATINJAU laga malam/dini hari (sampai 06:00 besok) supaya situs tidak kosong di siang hari; sesi 21:00 menghitung ulang laga itu.
  const endAll = (dayStartWib + DAY - off) - 1000;
  return { start, end, endAll, dayStart, slot, dateA, dateB, dateDay: new Date(dayStartWib).toISOString().slice(0, 10) };
}

/** Sesi sebuah laga menurut jam kickoff (WIB): 06:00-20:59 pagi, selebihnya malam. */
export function slotOfTs(ts: number): Slot { const h = (new Date(ts * 1000).getUTCHours() + CFG.tzOffsetHours) % 24; return h >= CFG.slotHoursWIB.pagi && h < CFG.slotHoursWIB.malam ? 'pagi' : 'malam'; }

function writeAtomic(dir: string, name: string, obj: unknown) {
  const tmp = path.join(dir, name.replace('.json', '.tmp.json')), final = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj));
  JSON.parse(fs.readFileSync(tmp, 'utf8')); // validasi sebelum menimpa file lama
  fs.renameSync(tmp, final);
}
const readJson = <T>(f: string): T | null => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** Konteks tabel (poin, peringkat, sisa laga) untuk laga liga domestik. Null bila datanya tidak layak (bukan liga kandang-tandang penuh,
 *  poin tidak ada, tim dari sumber berbeda, atau musim belum cukup berjalan) -> tidak ada label dan tidak ada penyesuaian. */
export function buildTable(leagueId: number, pool: { official: Row[] | null; own: Row[] } | undefined, hr: Row, ar: Row): TableCtx | null {
  if (!CFG.stakesLeagues.has(leagueId) || !pool || hr.source !== ar.source || typeof hr.points !== 'number' || typeof ar.points !== 'number') return null;
  const list = hr.source === 'official' ? pool.official : hr.source === 'own' ? pool.own : null;
  if (!list || list.length < 8 || list.length > 24 || list.some(r => typeof r.points !== 'number')) return null;
  const N = list.length, G = 2 * (N - 1);
  if (list.some(r => r.all.played > G)) return null;
  const c = tableCtx(list.map(r => ({ pts: r.points!, p: r.all.played })), { pts: hr.points, p: hr.all.played }, { pts: ar.points, p: ar.all.played }, N, G);
  return seasonPhase(c) >= CFG.stakesMinPhase ? c : null;
}

async function main() {
  const now = Date.now(), w = computeWindow(now);
  const win = { start: new Date(w.start).toISOString(), end: new Date(w.endAll).toISOString() };
  const prevMeta = readJson<Metadata>(path.join(CFG.dataDir, 'metadata.json'));
  const fail = (message: string) => {
    console.error('::warning::' + message);
    // predictions.json lama TIDAK disentuh
    writeAtomic(CFG.dataDir, 'metadata.json', { status: 'failed', message, attemptedAt: new Date(now).toISOString(), lastSuccessAt: prevMeta?.generatedAt ?? prevMeta?.lastSuccessAt, window: win } as Metadata);
  };

  try { const n = pruneCache(CFG.cacheDir, CFG.cachePruneDays); if (n) console.log(`[cache] ${n} file lama dihapus`); } catch {}
  const keys = readApiKeys(); // FOOTBALL_API_KEY (+ _2.._5 / FOOTBALL_API_KEYS): dipakai berurutan, pindah otomatis saat kuota habis
  if (!keys.length) return fail('FOOTBALL_API_KEY belum diisi di GitHub Secrets.');
  const usage = new ApiUsage(path.join(CFG.cacheDir, 'usage.json'), CFG.dailyRequestLimit, CFG.requestReserve);
  const api = new FootballApi(keys, usage);
  console.log(`[api] ${keys.length} key API-Football, batas total ${usage.limit} request/hari`);

  // 1) Fixture (2 request: tanggal WIB hari ini & besok, lalu difilter ke window)
  const fxRes = [await api.get('fixtures', { date: w.dateA, timezone: 'Asia/Jakarta' }, CFG.fixturesTtlH),
                 await api.get('fixtures', { date: w.dateB, timezone: 'Asia/Jakarta' }, CFG.fixturesTtlH)];
  if (fxRes.every(r => r === null)) return fail('Football API gagal dan tidak ada cache valid. Prediksi lama dipertahankan.');
  const seen = new Set<number>();
  const fixtures = fxRes.flatMap(r => r?.data ?? []).filter((f: any) => {
    if (seen.has(f.fixture.id)) return false; seen.add(f.fixture.id);
    const t = f.fixture.timestamp * 1000;
    return t >= w.start && t <= w.endAll && f.fixture.status.short === 'NS' && (CFG.allLeagues || CFG.leagues.includes(f.league.id)) && isSeniorMen(f);
  });
  console.log(`Window ${win.start} → ${win.end}: ${fixtures.length} pertandingan`);

  // 2) Kumpulkan hasil pertandingan selesai -> klasemen buatan sendiri (data/results.json, 1 request/hari)
  const results = loadResults(CFG.resultsFile), lastBefore = results.lastDate;
  // Sesi malam melewati pengumpulan hasil (sudah dilakukan sesi pagi; hemat kuota)
  const col = w.slot === 'pagi' ? await collectResults(api, results, w.dateA) : { added: 0, days: 0, stoppedEarly: false };
  if (results.lastDate !== lastBefore || col.added) saveResults(CFG.resultsFile, results);
  console.log(`Hasil: +${col.added} laga dari ${col.days} hari (terakhir ${results.lastDate ?? '-'})${col.stoppedEarly ? ' [berhenti: API menolak/gagal]' : ''}`);
  // 2b) Rekam jejak: nilai prediksi lama vs hasil sebenarnya, tuning otomatis tau & bobot pasar (public/data/calibration.json)
  try { evaluate(); } catch (e) { console.warn('[evaluasi] gagal:', (e as Error).message); }
  const cal = activeCalibration();

  // 3) Tentukan baris klasemen tiap tim. Prioritas: resmi (football-data.org / API-Football) > hasil sendiri > Gemini (tervalidasi, ditandai)
  const groups = new Map<string, any[]>();
  for (const f of fixtures) { const k = `${f.league.id}:${f.league.season}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(f); }
  const order = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const eloByLeague = new Map<string, Map<number, number>>(); let eloClubs: Awaited<ReturnType<typeof fetchClubElo>> = null, eloNations: typeof eloClubs = null, eloLoaded = { c: false, n: false };
  const tablePool = new Map<string, { official: Row[] | null; own: Row[] }>(); const rowsByLeague = new Map<string, Map<number, Row>>(); const avgByLeague = new Map<string, ReturnType<typeof leagueAverages>>();
  const fdKey = process.env.FOOTBALL_DATA_KEY, gKey = process.env.GEMINI_API_KEY; let aiCalls = 0, apiStandingsCalls = 0, groupCalls = 0; const groupsByLeague = new Map<string, GroupTable[]>();
  for (const [k, fxs] of order) {
    const [league, season] = k.split(':'), lid = Number(league);
    const teams = [...new Map(fxs.flatMap((f: any) => [f.teams.home, f.teams.away]).map((t: any) => [t.id, { id: t.id, name: t.name }])).values()] as { id: number; name: string }[];
    const own = ownRows(results.leagues[k]), resolved = new Map<number, Row>(); let pool: Row[] | null = null;
    const withForm = (r: Row, id: number): Row => ({ ...r, form: r.form ?? own.get(id)?.form ?? null });
    const code = CFG.fdCompetitions[lid];
    if (code && fdKey) { const rows = await fdStandings(code, fdKey); if (rows?.length) { pool = rows; for (const [id, r] of matchTeams(teams, rows)) resolved.set(id, withForm(r, id)); } }
    if (CFG.useApiStandings && apiStandingsCalls < CFG.maxStandingsRequests && teams.some(t => !resolved.has(t.id))) {
      apiStandingsCalls++;
      const r = await api.get('standings', { league, season }, CFG.standingsTtlH);
      for (const x of (r?.data?.[0]?.league?.standings ?? []).flat()) if (teams.some(t => t.id === x.team.id) && !resolved.has(x.team.id)) resolved.set(x.team.id, { ...x, source: 'official' });
    }
    for (const t of teams) { const o = own.get(t.id); if (!resolved.has(t.id) && o && o.all.played > 0) resolved.set(t.id, o); }
    if (CFG.useElo) { // Elo: tim nasional dari eloratings.net, klub dari ClubElo (1 request per sumber per run, di-cache)
      const nat = CFG.nationalLeagues.has(lid);
      if (nat || clubEloCovered(lid)) {
      if (nat && !eloLoaded.n) { eloLoaded.n = true; eloNations = await fetchNationalElo(); }
      if (!nat && !eloLoaded.c) { eloLoaded.c = true; eloClubs = await fetchClubElo(); }
      const pool = nat ? eloNations : eloClubs;
      if (pool) eloByLeague.set(k, matchElo(teams, pool, nat ? undefined : clubCountry(lid)));
      }
    }
    if (gKey && CFG.geminiStandings && !CFG.noStandingsLeagues.has(lid) && aiCalls < CFG.geminiStandingsMaxCalls) {
      const need = teams.filter(t => { const r = resolved.get(t.id); if (!r && eloByLeague.get(k)?.has(t.id)) return false; /* sudah tercakup Elo */ return !r || (r.source === 'own' && r.all.played < CFG.minOwnGames); });
      if (need.length) { aiCalls++; for (const [id, r] of await aiStandings(gKey, { id: lid, name: fxs[0].league.name, country: fxs[0].league.country, season: Number(season) }, need, own)) resolved.set(id, withForm(r, id)); }
    }
    // v5: klasemen GRUP turnamen/kualifikasi timnas (1 request per turnamen, di-cache) -> status sudah lolos / sudah gugur. Gagal/kosong -> tanpa konteks grup.
    if (CFG.ctxGroup && CFG.groupLeagues.has(lid) && groupCalls < CFG.maxGroupStandings && fxs.some((f: any) => /group|league (stage|phase)|regular season/i.test(String(f.league.round ?? '')))) {
      groupCalls++;
      const r = await api.get('standings', { league, season }, CFG.standingsTtlH), gt = parseGroups(lid, r?.data?.[0]?.league?.standings ?? []);
      if (gt.length) groupsByLeague.set(k, gt);
    }
    tablePool.set(k, { official: pool && pool.every(r => typeof r.points === 'number') ? pool : null, own: [...own.values()] });
    rowsByLeague.set(k, resolved);
    avgByLeague.set(k, leagueAverages(pool ?? (own.size ? [...own.values()] : [...resolved.values()])));
  }

  // v5: konteks laga. Riwayat waktu laga per tim = results.json (laga selesai) + jadwal laga lain di window yang sama.
  const sched = new Map<number, number[]>();
  for (const f of fixtures) for (const t of [f.teams.home.id, f.teams.away.id]) (sched.get(t) ?? sched.set(t, []).get(t)!).push(f.fixture.timestamp);
  const recentOf = (id: number, ts: number) => [...(results.recent?.[id] ?? []), ...(sched.get(id) ?? []).filter(t => t < ts)];
  // ai = sinyal AI tervalidasi (opsional), table = tabel liga (untuk menghindari motivasi dihitung dua kali)
  const ctxFor = (f: any, ai?: AiCtx, table?: TableCtx | null) => {
    const ts = f.fixture.timestamp, k = `${f.league.id}:${f.league.season}`, round = String(f.league.round ?? '');
    const leg1 = isKnockoutRound(round) ? results.legs?.[legKey(f.league.id, f.league.season, round, f.teams.home.id, f.teams.away.id)] : undefined;
    const grp = groupsByLeague.get(k), group = grp ? findGroup(grp, f.teams.home.id, f.teams.away.id) : undefined;
    return buildContext({ leagueId: f.league.id, season: f.league.season, round, ts, home: { id: f.teams.home.id, name: f.teams.home.name, recent: recentOf(f.teams.home.id, ts) }, away: { id: f.teams.away.id, name: f.teams.away.name, recent: recentOf(f.teams.away.id, ts) }, leg1, group, ai, tableKnown: tableKnown(table) });
  };
  const hasLeg1 = (f: any) => !!(isKnockoutRound(String(f.league.round ?? '')) && results.legs?.[legKey(f.league.id, f.league.season, String(f.league.round ?? ''), f.teams.home.id, f.teams.away.id)]);
  const preds: Prediction[] = []; let skipped = 0; const bySrc = { official: 0, own: 0, ai: 0, elo: 0, market: 0 };
  const cand: { f: any; hr: Row | null; ar: Row | null; elo: any; table: TableCtx | null }[] = [], nodata: any[] = [];
  for (const f of fixtures) {
    const k = `${f.league.id}:${f.league.season}`, rows = rowsByLeague.get(k);
    const hr = rows?.get(f.teams.home.id), ar = rows?.get(f.teams.away.id), em = eloByLeague.get(k);
    const eh = em?.get(f.teams.home.id), ea = em?.get(f.teams.away.id);
    const elo = eh && ea ? { home: eh, away: ea, neutral: CFG.neutralLeagues.has(f.league.id) } : null;
    if (!(hr && ar) && !elo) { skipped++; nodata.push(f); continue; } // tidak ada klasemen maupun Elo => hanya boleh diprediksi dari odds pasar (di bawah), tidak pernah dikarang
    cand.push({ f, hr: hr && ar ? hr : null, ar: hr && ar ? ar : null, elo, table: hr && ar ? buildTable(f.league.id, tablePool.get(k), hr, ar) : null });
  }
  // 3b) Cedera/skorsing/skuad: API-Football injuries + Gemini berita (opsional, gagal => lanjut tanpa penyesuaian)
  // v6: petunjuk konteks (apa yang sudah dihitung sistem) ikut di prompt berita yang sama -> tanpa panggilan Gemini/kredit Tavily tambahan
  const ctxHints = new Map<number, CtxHint>(cand.map(c => [c.f.fixture.id, ctxHint(c.f, ctxFor(c.f, undefined, c.table), c.table, hasLeg1(c.f))]));
  const abs = cand.length ? await collectAbsences(api, cand.map(c => c.f), [w.dateA, w.dateB], gKey, ctxHints) : { map: new Map(), nApi: 0, nAi: 0, error: undefined as string | undefined, ctx: new Map<number, AiCtx>(), nCtx: 0 };
  // 3c) Odds pasar (sinyal statistik). Gagal/kuota habis => laga diprediksi tanpa pasar.
  const mkt = cand.length ? await collectOdds(api, cand.map(c => c.f)) : { map: new Map(), requested: 0 };
  // 3d) Laga tanpa klasemen/Elo (mis. liga kecil, klub Afrika): bila odds pasar ada, prediksi dari odds saja (ditandai 'Pasar', keyakinan dipotong).
  //     Liga prioritas (DEFAULT_LEAGUES) didahulukan, lalu jam kickoff; memakai sisa kuota odds.
  if (nodata.length && CFG.useOdds) {
    const ord = [...nodata].sort((a, b) => (+!CFG.leagues.includes(a.league.id) - +!CFG.leagues.includes(b.league.id)) || a.fixture.timestamp - b.fixture.timestamp);
    const r2 = await collectOdds(api, ord, Math.max(0, CFG.oddsMaxRequests - mkt.requested), mkt.map, true);
    mkt.requested += r2.requested;
    for (const f of ord) {
      const mk = mkt.map.get(f.fixture.id); if (!mk) continue;
      const lg = avgByLeague.get(`${f.league.id}:${f.league.season}`)!;
      cand.push({ f, hr: null, ar: null, elo: marketElo(mk, lg), table: null }); skipped--;
    }
  }
  for (const c of cand) {
    if (c.hr && c.ar) { bySrc[c.hr.source]++; bySrc[c.ar.source]++; } else if (c.elo?.fromMarket) bySrc.market += 2; else bySrc.elo += 2;
    preds.push(buildPrediction(c.f, c.hr, c.ar, avgByLeague.get(`${c.f.league.id}:${c.f.league.season}`)!, c.elo, abs.map.get(c.f.fixture.id), { market: mkt.map.get(c.f.fixture.id), marketW: cal.marketW, tau: cal.tau, table: c.table, ctx: ctxFor(c.f, abs.ctx.get(c.f.fixture.id), c.table) }));
  }
  for (const p of preds) { p.slot = slotOfTs(p.timestamp); if (w.slot === 'pagi' && p.slot === 'malam') p.preview = true; p.headline = pickHeadline(p, CFG.headlineMinP); }
  preds.sort((a, b) => a.timestamp - b.timestamp);

  // 4) Gemini (opsional; gagal => tetap ada prediksi)
  const ai = preds.length ? await addAiSummaries(preds, process.env.GEMINI_API_KEY) : { used: false, model: CFG.geminiModel, summarized: 0, error: undefined };

  const op = preds.length ? await addAiOpinions(preds, process.env.GEMINI_API_KEY) : { done: 0, agree: 0, error: undefined as string | undefined };

  // 5) Tulis atomik + history
  // Sesi malam: pertahankan laga sesi pagi hari yang sama (dari predictions.json sebelumnya) agar beranda tetap menampilkan seluruh hari.
  let kept: Prediction[] = [];
  if (w.slot === 'malam') {
    const prev = readJson<PredictionsFile>(path.join(CFG.dataDir, 'predictions.json'));
    if (prev && Date.parse(prev.window?.start) >= w.dayStart - 1000 && Date.parse(prev.window?.start) < w.start) kept = prev.matches.filter(m => m.timestamp * 1000 >= w.dayStart && m.timestamp * 1000 < w.start);
  }
  const all = [...kept, ...preds].sort((a, b) => a.timestamp - b.timestamp);
  const fullWin = { start: new Date(kept.length ? w.dayStart : w.start).toISOString(), end: win.end };
  const out: PredictionsFile = { version: 1, generatedAt: new Date(now).toISOString(), window: fullWin, slot: w.slot,
    ai: { used: ai.used, model: ai.model, summarized: ai.summarized }, api: { used: usage.used, limit: usage.limit }, matches: all };
  writeAtomic(CFG.dataDir, 'predictions.json', out);
  writeAtomic(path.join(CFG.dataDir, 'history'), w.slot === 'pagi' ? `${w.dateDay}.json` : `${w.dateDay}-malam.json`, { ...out, matches: preds }); // history hanya laga sesi ini (evaluate memakai versi terbaru per laga)
  const aiSigs = [...abs.ctx.values()].reduce((a, c) => a + aiCtxCount(c), 0), aiMatches = [...abs.ctx.values()].filter(c => aiCtxCount(c) > 0).length;
  const meta: Metadata = { status: skipped && !preds.length && fixtures.length ? 'partial' : 'ok',
    message: `${preds.length} prediksi dibuat, ${skipped} dilewati (tanpa klasemen/Elo). Sumber tim: resmi ${bySrc.official}, hasil sendiri ${bySrc.own}, AI ${bySrc.ai}, Elo-saja ${bySrc.elo}, odds-saja ${bySrc.market}. Absen: AI ${abs.nAi} laga, API ${abs.nApi} laga. Pasar: ${mkt.map.size} laga. Konteks AI: ${aiMatches} laga bersinyal dari ${abs.nCtx} diperiksa. Kalibrasi: ${cal.n} laga dinilai, tau ${cal.tau}, bobot pasar ${cal.marketW}.`,
    generatedAt: out.generatedAt, attemptedAt: out.generatedAt, window: win,
    counts: { fixtures: fixtures.length, predicted: preds.length, skippedNoStandings: skipped },
    dataSources: { ...bySrc, resultsCollected: col.added, resultsLastDate: results.lastDate },
    api: { used: usage.used, limit: usage.limit, fixturesSource: fxRes.map(r => r?.source ?? 'none').join('+') },
    absences: { api: abs.nApi, ai: abs.nAi, error: abs.error }, aiContext: { checked: abs.nCtx, matches: aiMatches, signals: aiSigs },
    market: { matched: mkt.map.size, requested: mkt.requested }, calibration: { n: cal.n, tau: cal.tau, marketW: cal.marketW },
    gemini: { used: ai.used, model: ai.model, summarized: ai.summarized, opinions: op.done, opinionAgree: op.agree, error: ai.error ?? op.error } };
  writeAtomic(CFG.dataDir, 'metadata.json', meta);
  console.log(meta.message, `API ${usage.used}/${usage.limit}`, `AI ${ai.summarized}`);
}
if (process.argv[1]?.endsWith("run.ts") || process.env.FORCE_RUN) main().catch(e => { console.error('::warning::' + e); process.exit(0); });