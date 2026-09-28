import fs from 'node:fs';
import path from 'node:path';
import type { Prediction, PredictionsFile, Metadata } from '../shared/types.ts';
import { CFG } from './config.ts';
import { ApiUsage } from './apiUsage.ts';
import { FootballApi } from './footballApi.ts';
import { buildPrediction, leagueAverages } from './engine.ts';
import { addAiSummaries } from './gemini.ts';

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

  // 2) Klasemen: 1 request per liga (sudah berisi gol kandang/tandang + form) => tanpa endpoint teams/statistics
  const groups = new Map<string, any[]>();
  for (const f of fixtures) { const k = `${f.league.id}:${f.league.season}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(f); }
  const order = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, CFG.maxStandingsRequests);
  const rowsByLeague = new Map<string, Map<number, any>>(); const avgByLeague = new Map<string, ReturnType<typeof leagueAverages>>();
  for (const [k] of order) {
    const [league, season] = k.split(':');
    const r = await api.get('standings', { league, season }, CFG.standingsTtlH);
    const rows = (r?.data?.[0]?.league?.standings ?? []).flat();
    if (!rows.length) continue;
    rowsByLeague.set(k, new Map(rows.map((x: any) => [x.team.id, x]))); avgByLeague.set(k, leagueAverages(rows));
  }

  // 3) Prediksi deterministik
  const preds: Prediction[] = []; let skipped = 0;
  for (const f of fixtures) {
    const k = `${f.league.id}:${f.league.season}`, rows = rowsByLeague.get(k);
    const hr = rows?.get(f.teams.home.id), ar = rows?.get(f.teams.away.id);
    if (!hr || !ar) { skipped++; continue; } // data tidak ada => jangan mengarang
    preds.push(buildPrediction(f, hr, ar, avgByLeague.get(k)!));
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
    message: `${preds.length} prediksi dibuat, ${skipped} dilewati (tanpa data klasemen).`,
    generatedAt: out.generatedAt, attemptedAt: out.generatedAt, window: win,
    counts: { fixtures: fixtures.length, predicted: preds.length, skippedNoStandings: skipped },
    api: { used: usage.used, limit: usage.limit, fixturesSource: fxRes.map(r => r?.source ?? 'none').join('+') },
    gemini: { used: ai.used, model: ai.model, summarized: ai.summarized, error: ai.error } };
  writeAtomic(CFG.dataDir, 'metadata.json', meta);
  console.log(meta.message, `API ${usage.used}/${usage.limit}`, `AI ${ai.summarized}`);
}
if (process.argv[1]?.endsWith("run.ts") || process.env.FORCE_RUN) main().catch(e => { console.error('::warning::' + e); process.exit(0); });
