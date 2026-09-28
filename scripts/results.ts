import fs from 'node:fs';
import path from 'node:path';
import { CFG } from './config.ts';
import type { FootballApi } from './footballApi.ts';
import type { Row } from './standings.ts';

/** ===== Klasemen buatan sendiri dari hasil pertandingan (fixture berstatus selesai) =====
 * 1 request/hari (fixture kemarin). Disimpan di data/results.json dan di-commit oleh workflow. */
export interface S { p: number; gf: number; ga: number }
export interface TeamRec { name: string; pts: number; all: S; home: S; away: S; form: string }
export interface ResultsFile { version: 1; lastDate: string | null; seenIds: number[]; leagues: Record<string, Record<string, TeamRec>> }

export const emptyResults = (): ResultsFile => ({ version: 1, lastDate: null, seenIds: [], leagues: {} });
export function loadResults(file: string): ResultsFile {
  try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); if (o?.version === 1 && o.leagues) return o; } catch {}
  return emptyResults();
}
export function saveResults(file: string, r: ResultsFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file.replace('.json', '.tmp.json');
  fs.writeFileSync(tmp, JSON.stringify({ ...r, seenIds: r.seenIds.slice(-4000) }));
  JSON.parse(fs.readFileSync(tmp, 'utf8')); fs.renameSync(tmp, file);
}

const DONE = new Set(['FT', 'AET', 'PEN']);
const blank = (name: string): TeamRec => ({ name, pts: 0, all: { p: 0, gf: 0, ga: 0 }, home: { p: 0, gf: 0, ga: 0 }, away: { p: 0, gf: 0, ga: 0 }, form: '' });
function apply(t: TeamRec, side: 'home' | 'away', gf: number, ga: number) {
  for (const s of [t.all, t[side]]) { s.p++; s.gf += gf; s.ga += ga; }
  const r = gf > ga ? 'W' : gf === ga ? 'D' : 'L';
  t.pts += r === 'W' ? 3 : r === 'D' ? 1 : 0; t.form = (t.form + r).slice(-5);
}

/** Tambahkan satu fixture selesai. Return false bila dilewati (belum selesai / duplikat / skor kosong). */
export function addFixture(res: ResultsFile, f: any): boolean {
  const id = f?.fixture?.id, hg = f?.goals?.home, ag = f?.goals?.away;
  if (!DONE.has(f?.fixture?.status?.short) || typeof hg !== 'number' || typeof ag !== 'number') return false;
  if (res.seenIds.includes(id)) return false;
  const k = `${f.league.id}:${f.league.season}`, lg = (res.leagues[k] ??= {});
  const H = (lg[f.teams.home.id] ??= blank(f.teams.home.name)), A = (lg[f.teams.away.id] ??= blank(f.teams.away.name));
  apply(H, 'home', hg, ag); apply(A, 'away', ag, hg); res.seenIds.push(id);
  return true;
}

export function addDays(date: string, n: number) { return new Date(Date.parse(date + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10); }

/** Ambil hasil untuk tanggal (lastDate+1 .. dateA-1). Berhenti di kegagalan pertama (mis. paket gratis menolak tanggal lampau) tanpa memajukan lastDate. */
export async function collectResults(api: FootballApi, res: ResultsFile, dateA: string) {
  const last = addDays(dateA, -1);
  let from = res.lastDate ? addDays(res.lastDate, 1) : addDays(dateA, -CFG.backfillDays);
  const out = { added: 0, days: 0, stoppedEarly: false };
  while (from <= last && out.days < CFG.maxResultDaysPerRun) {
    const r = await api.get('fixtures', { date: from, timezone: 'Asia/Jakarta' }, 24 * 365);
    if (!r) { out.stoppedEarly = true; break; }
    const fin = r.data.filter((f: any) => (CFG.allLeagues || CFG.leagues.includes(f.league.id))).sort((a: any, b: any) => a.fixture.timestamp - b.fixture.timestamp);
    for (const f of fin) if (addFixture(res, f)) out.added++;
    res.lastDate = from; out.days++; from = addDays(from, 1);
  }
  return out;
}

/** Ubah catatan tim -> baris berformat klasemen. Peringkat dihitung dari poin, selisih gol, gol. */
export function ownRows(recs: Record<string, TeamRec> | undefined): Map<number, Row> {
  const list = Object.entries(recs ?? {}).map(([id, t]) => ({ id: Number(id), t }));
  list.sort((a, b) => b.t.pts - a.t.pts || (b.t.all.gf - b.t.all.ga) - (a.t.all.gf - a.t.all.ga) || b.t.all.gf - a.t.all.gf);
  const sp = (s: S) => ({ played: s.p, goals: { for: s.gf, against: s.ga } });
  return new Map(list.map(({ id, t }, i) => [id, { team: { id, name: t.name }, rank: i + 1, form: t.form || null, all: sp(t.all), home: sp(t.home), away: sp(t.away), source: 'own' as const }]));
}
