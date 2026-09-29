import { CFG } from './config.ts';
import { readCache, writeCache } from './cache.ts';
import { matchTeams, type Row } from './standings.ts';

/** ===== Peringkat Elo sebagai sumber kekuatan tim (klub: ClubElo, tim nasional: eloratings.net) ===== */
export interface EloEntry { name: string; elo: number; country?: string }
const HDR = { 'User-Agent': 'prediksi-bola/1.0 (github actions)' };

async function getText(url: string): Promise<string> {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 20000);
  try { const r = await fetch(url, { headers: HDR, signal: ctl.signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.text(); }
  finally { clearTimeout(t); }
}
async function cached(key: string, load: () => Promise<EloEntry[]>): Promise<EloEntry[] | null> {
  const c = readCache<EloEntry[]>(CFG.cacheDir, key);
  if (c && (Date.now() - c.ts) / 3.6e6 <= CFG.eloTtlH) return c.data;
  try {
    const d = await load(); if (d.length < 20) throw new Error('data terlalu sedikit');
    writeCache(CFG.cacheDir, key, d); return d;
  } catch (e) {
    console.warn(`[elo] gagal ${key}: ${(e as Error).message}`);
    return c && (Date.now() - c.ts) / 3.6e6 <= CFG.maxStaleH ? c.data : null;
  }
}

/** CSV ClubElo: Rank,Club,Country,Level,Elo,From,To */
export function parseClubElo(csv: string): EloEntry[] {
  const out: EloEntry[] = [];
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const c = line.split(','); if (c.length < 5) continue;
    const elo = Number(c[4]); if (c[1] && Number.isFinite(elo) && elo > 500 && elo < 2800) out.push({ name: c[1], country: c[2], elo });
  }
  return out;
}
/** eloratings.net: World.tsv (kode tim + rating) dan en.teams.tsv (kode -> nama). Kolom dicari secara toleran. */
export function parseNationalElo(worldTsv: string, teamsTsv: string): EloEntry[] {
  const names = new Map<string, string>();
  for (const l of teamsTsv.split(/\r?\n/)) { const c = l.split('\t'); if (c.length >= 2 && c[0] && c[1]) names.set(c[0].trim(), c[1].trim()); }
  const out: EloEntry[] = [];
  for (const l of worldTsv.split(/\r?\n/)) {
    const c = l.split('\t'); const i = c.findIndex(x => names.has(x.trim())); if (i < 0) continue;
    const elo = c.slice(i + 1).map(Number).find(n => Number.isFinite(n) && n >= 800 && n <= 2500); // rating pertama yang masuk akal setelah kode
    if (elo) out.push({ name: names.get(c[i].trim())!, elo });
  }
  return out;
}
export const fetchClubElo = () => cached('elo_clubs', async () => {
  const d = new Date().toISOString().slice(0, 10);
  try { return parseClubElo(await getText(`https://api.clubelo.com/${d}`)); } catch { return parseClubElo(await getText(`http://api.clubelo.com/${d}`)); }
});
export const fetchNationalElo = () => cached('elo_nations', async () =>
  parseNationalElo(await getText('https://www.eloratings.net/World.tsv'), await getText('https://www.eloratings.net/en.teams.tsv')));

// Nama API-Football (huruf kecil) -> nama di sumber Elo. Hanya yang jauh berbeda; sisanya dicocokkan otomatis.
const ALIAS: Record<string, string> = {
  'manchester united': 'Man United', 'manchester city': 'Man City', 'bayern munich': 'Bayern', 'borussia dortmund': 'Dortmund',
  'bayer leverkusen': 'Leverkusen', 'borussia monchengladbach': 'Gladbach', 'eintracht frankfurt': 'Frankfurt', 'atletico madrid': 'Atletico',
  'athletic club': 'Athletic', 'real sociedad': 'Sociedad', 'paris saint germain': 'Paris SG', 'olympique marseille': 'Marseille',
  'olympique lyonnais': 'Lyon', 'newcastle': 'Newcastle', 'tottenham': 'Tottenham', 'wolves': 'Wolves', 'nottingham forest': "Forest",
  'sporting cp': 'Sporting', 'sporting lisbon': 'Sporting', 'fc porto': 'Porto', 'benfica': 'Benfica', 'psv eindhoven': 'PSV', 'ajax': 'Ajax',
  'red bull salzburg': 'Salzburg', 'shakhtar donetsk': 'Shakhtar', 'dynamo kyiv': 'Dynamo Kyiv', 'celtic': 'Celtic', 'inter': 'Inter', 'as roma': 'Roma',
  'west ham': 'West Ham', 'brighton': 'Brighton', 'leeds': 'Leeds', 'ac milan': 'Milan', 'napoli': 'Napoli',
  'usa': 'United States', 'korea republic': 'South Korea', 'south korea': 'South Korea', 'ir iran': 'Iran', 'czech republic': 'Czechia', 'turkey': 'Turkey', 'turkiye': 'Turkey',
  'ivory coast': "Cote d'Ivoire", "cote d'ivoire": "Cote d'Ivoire", 'congo dr': 'DR Congo', 'dr congo': 'DR Congo', 'cape verde islands': 'Cape Verde', 'bosnia and herzegovina': 'Bosnia and Herzegovina',
  'north macedonia': 'North Macedonia', 'china pr': 'China', 'curacao': 'Curacao', 'united arab emirates': 'United Arab Emirates', 'russia': 'Russia',
};
// Kompetisi klub -> kode negara ClubElo (mempersempit kandidat). Kompetisi lintas negara tidak difilter.
const CLUB_COUNTRY: Record<number, string> = { 39: 'ENG', 40: 'ENG', 140: 'ESP', 135: 'ITA', 78: 'GER', 61: 'FRA', 88: 'NED', 94: 'POR', 144: 'BEL', 179: 'SCO', 203: 'TUR' };
const YOUTH = /\bu-?\d{2}\b|\bwomen\b|\bw$|\bolympic\b|\bb$|\bii$/i; // tim usia/wanita/cadangan tidak punya Elo senior

/** Cocokkan tim fixture ke entri Elo. Kembalikan teamId -> rating. Ambigu/tidak ada -> tidak dikembalikan (tidak mengarang). */
export function matchElo(teams: { id: number; name: string }[], pool: EloEntry[], country?: string): Map<number, number> {
  const p = country ? pool.filter(e => e.country === country) : pool;
  const rows: Row[] = p.map((e, i) => ({ team: { id: i, name: e.name }, all: { played: 0, goals: { for: 0, against: 0 } }, home: { played: 0, goals: { for: 0, against: 0 } }, away: { played: 0, goals: { for: 0, against: 0 } }, source: 'official' }));
  const usable = teams.filter(t => !YOUTH.test(t.name)).map(t => ({ id: t.id, name: ALIAS[t.name.toLowerCase()] ?? t.name }));
  const out = new Map<number, number>();
  for (const [id, r] of matchTeams(usable, rows)) out.set(id, p[r.team.id].elo);
  return out;
}
/** Liga/kompetisi yang klub-klubnya tercakup ClubElo (Eropa). Di luar itu (Brasil, MLS, dll.) tidak dicoba supaya tidak salah cocok. */
export const clubEloCovered = (leagueId: number) => leagueId in CLUB_COUNTRY || [2, 3, 848].includes(leagueId);
export const clubCountry = (leagueId: number) => CLUB_COUNTRY[leagueId];
