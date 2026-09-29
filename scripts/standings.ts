import type { DataSource } from '../shared/types.ts';

/** Format baris klasemen yang dibaca engine.ts (sama dengan bentuk respons API-Football standings). */
export interface Split { played: number; goals: { for: number; against: number } }
export interface Row {
  team: { id: number; name: string }; names?: string[]; // names = nama alternatif (shortName, dll) untuk pencocokan
  rank?: number | null; form?: string | null; points?: number; // points: dipakai untuk membaca situasi tabel (juara / 4 besar / degradasi)
  all: Split; home: Split; away: Split; source: DataSource;
}

const STOP = new Set(['fc', 'cf', 'afc', 'sc', 'ac', 'as', 'ss', 'ssc', 'us', 'rc', 'rcd', 'fk', 'sk', 'ud', 'cd', 'sv', 'vfb', 'vfl', 'tsg', 'fsv', 'bsc', 'ca', 'club', 'de', 'calcio', 'the']);
export const tokens = (s: string): string[] =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ß/g, 'ss').replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/).filter(t => t && !STOP.has(t) && !/^\d+$/.test(t));

/** 3 = nama identik, 2 = himpunan kata salah satunya termuat di yang lain, 1 = awalan kata cocok (Inter ~ Internazionale), 0 = beda. */
function sim(a: string, b: string): number {
  const A = tokens(a), B = tokens(b); if (!A.length || !B.length) return 0;
  if (A.join(' ') === B.join(' ')) return 3;
  if (A.every(t => B.includes(t)) || B.every(t => A.includes(t))) return 2;
  const pre = (x: string, y: string) => x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x));
  return A.some(x => B.some(y => pre(x, y))) ? 1 : 0;
}

/** Cocokkan tim fixture (nama API-Football) ke baris sumber lain (ID berbeda) lewat nama. Satu-ke-satu; ambigu -> tidak dicocokkan. */
export function matchTeams(teams: { id: number; name: string }[], rows: Row[]): Map<number, Row> {
  const out = new Map<number, Row>(), used = new Set<Row>();
  const level = (t: { name: string }, r: Row) => Math.max(...[r.team.name, ...(r.names ?? [])].map(n => sim(t.name, n)));
  for (const lv of [3, 2, 1]) for (const t of teams) {
    if (out.has(t.id)) continue;
    const c = rows.filter(r => !used.has(r) && level(t, r) === lv);
    if (c.length === 1) { out.set(t.id, c[0]); used.add(c[0]); }
  }
  return out;
}
