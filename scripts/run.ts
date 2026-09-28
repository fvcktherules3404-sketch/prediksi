import fs from 'node:fs';
import path from 'node:path';
import type { Prediction, PredictionsFile, Metadata } from '../shared/types.ts';
import { CFG } from './config.ts';
import { ApiUsage } from './apiUsage.ts';
import { FootballApi } from './footballApi.ts';
import { buildPrediction, leagueAverages } from './engine.ts';
import { addAiSummaries } from './gemini.ts';
import { loadResults, saveResults, collectResults, ownRows } from './results.ts';
import { fdStandings } from './footballData.ts';
import { collectAbsences } from './news.ts';
import { aiStandings } from './geminiStandings.ts';
import { matchTeams, type Row } from './standings.ts';
import { fetchClubElo, fetchNationalElo, matchElo, clubCountry, clubEloCovered } from './elo.ts';

const H = 3.6e6, DAY = 24 * H;
/** Window berdasarkan waktu eksekusi AKTUAL (cron GitHub boleh telat): batas 06:00 WIB terakhir <= sekarang. */
export function computeWindow(nowMs: number) {
  const off = CFG.tzOffsetHours * H, sh = CFG.windowStartHourWIB * H;
  const base = Math.floor((nowMs + off - sh) / DAY) * DAY + sh; // 06:00 WIB dalam "jam WIB"
  const start = base - off;
  return { start, end: start + DAY - 1000, dateA: new Date(base).toISOString().slice(0, 10), dateB: new Date(base + DAY).toISOString().slice(0, 10) };
}

function writeAtomic(dir: string, name: string, obj: unknown) {
  const tmp = path.join(dir, name.replace('.json', '.tmp.json')), final = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj));
  JSON.parse(fs.readFileSync(tmp, 'utf8')); // validasi sebelum menimpa file lama
  fs.renameSync(tmp, final);
}
const readJson = <T>(f: string): T | null => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

async function main() {
  const now = Date.now(), w = computeWindow(now);
  const win = { start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString() };
  const prevMeta = readJson<Metadata>(path.join(CFG.dataDir, 'metadata.json'));
  const fail = (message: string) => {
    console.error('::warning::' + message);
    // predictions.json lama TIDAK disentuh
    writeAtomic(CFG.dataDir, 'metadata.json', { status: 'failed', message, attemptedAt: new Date(now).toISOString(), lastSuccessAt: prevMeta?.generatedAt ?? prevMeta?.lastSuccessAt, window: win } as Metadata);
  };

  const key = process.env.FOOTBALL_API_KEY;
  if (!key) return fail('FOOTBALL_API_KEY belum diisi di GitHub Secrets.');
  const usage = new ApiUsage(path.join(CFG.cacheDir, 'usage.json'), CFG.dailyRequestLimit, CFG.requestReserve);
  const api = new FootballApi(key, usage);

  // 1) Fixture (2 request: tanggal WIB hari ini & besok, lalu difilter ke window)
  const fxRes = [await api.get('fixtures', { date: w.dateA, timezone: 'Asia/Jakarta' }, CFG.fixturesTtlH),
                 await api.get('fixtures', { date: w.dateB, timezone: 'Asia/Jakarta' }, CFG.fixturesTtlH)];
  if (fxRes.every(r => r === null)) return fail('Football API gagal dan tidak ada cache valid. Prediksi lama dipertahankan.');
  const seen = new Set<number>();
  const fixtures = fxRes.flatMap(r => r?.data ?? []).filter((f: any) => {
    if (seen.has(f.fixture.id)) return false; seen.add(f.fixture.id);
    const t = f.fixture.timestamp * 1000;
    return t >= w.start && t <= w.end && f.fixture.status.short === 'NS' && (CFG.allLeagues || CFG.leagues.includes(f.league.id));
  });
  console.log(`Window ${win.start} → ${win.end}: ${fixtures.length} pertandingan`);

  // 2) Kumpulkan hasil pertandingan selesai -> klasemen buatan sendiri (data/results.json, 1 request/hari)
  const results = loadResults(CFG.resultsFile), lastBefore = results.lastDate;
  const col = await collectResults(api, results, w.dateA);
  if (results.lastDate !== lastBefore || col.added) saveResults(CFG.resultsFile, results);
  console.log(`Hasil: +${col.added} laga dari ${col.days} hari (terakhir ${results.lastDate ?? '-'})${col.stoppedEarly ? ' [berhenti: API menolak/gagal]' : ''}`);

  // 3) Tentukan baris klasemen tiap tim. Prioritas: resmi (football-data.org / API-Football) > hasil sendiri > Gemini (tervalidasi, ditandai)
  const groups = new Map<string, any[]>();
  for (const f of fixtures) { const k = `${f.league.id}:${f.league.season}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(f); }
  const order = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const eloByLeague = new Map<string, Map<number, number>>(); let eloClubs: Awaited<ReturnType<typeof fetchClubElo>> = null, eloNations: typeof eloClubs = null, eloLoaded = { c: false, n: false };
  const rowsByLeague = new Map<string, Map<number, Row>>(); const avgByLeague = new Map<string, ReturnType<typeof leagueAverages>>();
  const fdKey = process.env.FOOTBALL_DATA_KEY, gKey = process.env.GEMINI_API_KEY; let aiCalls = 0, apiStandingsCalls = 0;
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
    rowsByLeague.set(k, resolved);
    avgByLeague.set(k, leagueAverages(pool ?? (own.size ? [...own.values()] : [...resolved.values()])));
  }

  const preds: Prediction[] = []; let skipped = 0; const bySrc = { official: 0, own: 0, ai: 0, elo: 0 };
  const cand: { f: any; hr: Row | null; ar: Row | null; elo: any }[] = [];
  for (const f of fixtures) {
    const k = `${f.league.id}:${f.league.season}`, rows = rowsByLeague.get(k);
    const hr = rows?.get(f.teams.home.id), ar = rows?.get(f.teams.away.id), em = eloByLeague.get(k);
    const eh = em?.get(f.teams.home.id), ea = em?.get(f.teams.away.id);
    const elo = eh && ea ? { home: eh, away: ea, neutral: CFG.neutralLeagues.has(f.league.id) } : null;
    if (!(hr && ar) && !elo) { skipped++; continue; } // tidak ada klasemen maupun Elo => jangan mengarang
    cand.push({ f, hr: hr && ar ? hr : null, ar: hr && ar ? ar : null, elo });
  }
  // 3b) Cedera/skorsing/skuad: API-Football injuries + Gemini berita (opsional, gagal => lanjut tanpa penyesuaian)
  const abs = cand.length ? await collectAbsences(api, cand.map(c => c.f), [w.dateA, w.dateB], gKey) : { map: new Map(), nApi: 0, nAi: 0, error: undefined as string | undefined };
  for (const c of cand) {
    if (c.hr && c.ar) { bySrc[c.hr.source]++; bySrc[c.ar.source]++; } else bySrc.elo += 2;
    preds.push(buildPrediction(c.f, c.hr, c.ar, avgByLeague.get(`${c.f.league.id}:${c.f.league.season}`)!, c.elo, abs.map.get(c.f.fixture.id)));
  }
  preds.sort((a, b) => a.timestamp - b.timestamp);

  // 4) Gemini (opsional; gagal => tetap ada prediksi)
  const ai = preds.length ? await addAiSummaries(preds, process.env.GEMINI_API_KEY) : { used: false, model: CFG.geminiModel, summarized: 0, error: undefined };

  // 5) Tulis atomik + history
  const out: PredictionsFile = { version: 1, generatedAt: new Date(now).toISOString(), window: win,
    ai: { used: ai.used, model: ai.model, summarized: ai.summarized }, api: { used: usage.used, limit: usage.limit }, matches: preds };
  writeAtomic(CFG.dataDir, 'predictions.json', out);
  writeAtomic(path.join(CFG.dataDir, 'history'), `${w.dateA}.json`, out);
  const meta: Metadata = { status: skipped && !preds.length && fixtures.length ? 'partial' : 'ok',
    message: `${preds.length} prediksi dibuat, ${skipped} dilewati (tanpa klasemen/Elo). Sumber tim: resmi ${bySrc.official}, hasil sendiri ${bySrc.own}, AI ${bySrc.ai}, Elo-saja ${bySrc.elo}. Absen: AI ${abs.nAi} laga, API ${abs.nApi} laga.`,
    generatedAt: out.generatedAt, attemptedAt: out.generatedAt, window: win,
    counts: { fixtures: fixtures.length, predicted: preds.length, skippedNoStandings: skipped },
    dataSources: { ...bySrc, resultsCollected: col.added, resultsLastDate: results.lastDate },
    api: { used: usage.used, limit: usage.limit, fixturesSource: fxRes.map(r => r?.source ?? 'none').join('+') },
    absences: { api: abs.nApi, ai: abs.nAi, error: abs.error },
    gemini: { used: ai.used, model: ai.model, summarized: ai.summarized, error: ai.error } };
  writeAtomic(CFG.dataDir, 'metadata.json', meta);
  console.log(meta.message, `API ${usage.used}/${usage.limit}`, `AI ${ai.summarized}`);
}
if (process.argv[1]?.endsWith("run.ts") || process.env.FORCE_RUN) main().catch(e => { console.error('::warning::' + e); process.exit(0); });
