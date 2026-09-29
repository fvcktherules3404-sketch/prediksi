import { CFG } from './config.ts';
import { readCache, writeCache } from './cache.ts';
import type { Row, Split } from './standings.ts';

let lastCall = 0;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Klasemen resmi football-data.org (paket gratis: 10 request/menit -> jeda 6,5 dtk antar panggilan jaringan). Cache 20 jam. */
export async function fdStandings(code: string, token: string): Promise<Row[] | null> {
  const ck = `fd_standings_${code}`, c = readCache<Row[]>(CFG.cacheDir, ck);
  if (c && (Date.now() - c.ts) / 3.6e6 <= CFG.fdTtlH) return c.data;
  try {
    const wait = 6500 - (Date.now() - lastCall); if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 20000);
    const res = await fetch(`${CFG.footballDataBase}/competitions/${code}/standings`, { headers: { 'X-Auth-Token': token }, signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = parseFdStandings(await res.json());
    if (!rows.length) throw new Error('tabel kosong');
    writeCache(CFG.cacheDir, ck, rows); return rows;
  } catch (e) {
    console.warn(`[football-data] gagal ${code}: ${(e as Error).message}`);
    return c && (Date.now() - c.ts) / 3.6e6 <= CFG.maxStaleH ? c.data : null;
  }
}

export function parseFdStandings(json: any): Row[] {
  const st: any[] = json?.standings ?? [], pick = (type: string) => st.filter(s => s.type === type).flatMap(s => s.table ?? []);
  const home = pick('HOME'), away = pick('AWAY'), sp = (x: any): Split => ({ played: x.playedGames ?? 0, goals: { for: x.goalsFor ?? 0, against: x.goalsAgainst ?? 0 } });
  return pick('TOTAL').filter(t => t?.team?.id).map((t): Row => {
    const h = home.find(x => x.team?.id === t.team.id), a = away.find(x => x.team?.id === t.team.id);
    return { team: { id: t.team.id, name: t.team.name }, names: [t.team.shortName, t.team.tla].filter(Boolean), rank: t.position ?? null, points: typeof t.points === 'number' ? t.points : undefined,
      form: typeof t.form === 'string' && t.form ? t.form.replace(/[^WDL]/g, '') : null,
      all: sp(t), home: h ? sp(h) : sp(t), away: a ? sp(a) : sp(t), source: 'official' }; // tanpa split -> pakai total
  });
}
