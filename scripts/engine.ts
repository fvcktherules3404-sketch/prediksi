import type { Prediction, AHLine } from '../shared/types.ts';

/** ===== MESIN STATISTIK DETERMINISTIK (tanpa AI) =====
 * 1. Kekuatan serang/bertahan dari klasemen (split kandang/tandang + keseluruhan)
 * 2. Shrinkage Bayesian ke rata-rata liga (sampel kecil tidak ekstrem)
 * 3. Penyesuaian form 5 laga terakhir (maks ±3%)
 * 4. Poisson + koreksi Dixon-Coles untuk skor rendah
 * 5. Matriks skor -> 1X2, Over/Under, BTTS, Handicap Asia (termasuk seperempat), fair odds
 */
export const MAXG = 10;
const FACT: number[] = [1];
for (let i = 1; i <= MAXG + 2; i++) FACT[i] = FACT[i - 1] * i;
export const pois = (k: number, l: number) => Math.exp(-l) * Math.pow(l, k) / FACT[k];
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const odds = (p: number) => (p > 0.0101 ? Math.round((1 / p) * 100) / 100 : 99);

export function scoreMatrix(lh: number, la: number, rho = -0.08): number[][] {
  const m: number[][] = []; let s = 0;
  for (let i = 0; i <= MAXG; i++) {
    m[i] = [];
    for (let j = 0; j <= MAXG; j++) {
      let t = 1;
      if (i === 0 && j === 0) t = 1 - lh * la * rho;
      else if (i === 0 && j === 1) t = 1 + lh * rho;
      else if (i === 1 && j === 0) t = 1 + la * rho;
      else if (i === 1 && j === 1) t = 1 - rho;
      const p = Math.max(0, pois(i, lh) * pois(j, la) * t);
      m[i][j] = p; s += p;
    }
  }
  return m.map(r => r.map(p => p / s));
}

const settle = (d: number, line: number) => { const x = d + line; return x > 1e-9 ? 'W' : Math.abs(x) < 1e-9 ? 'P' : 'L'; };
/** Handicap Asia untuk tim tuan rumah dengan garis `line` (mis. -0.25, +0.75). */
export function ahLine(m: number[][], line: number): AHLine {
  const quarter = Math.abs(line * 4) % 2 === 1;
  const comps = quarter ? [line - 0.25, line + 0.25] : [line];
  let win = 0, halfWin = 0, push = 0, halfLoss = 0, loss = 0;
  for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) {
    const p = m[i][j]; let w = 0, pu = 0, l = 0;
    for (const c of comps) { const r = settle(i - j, c); if (r === 'W') w++; else if (r === 'P') pu++; else l++; }
    if (!quarter) { if (w) win += p; else if (pu) push += p; else loss += p; }
    else if (w === 2) win += p; else if (w === 1) halfWin += p; else if (l === 2) loss += p; else halfLoss += p;
  }
  const pCover = win + halfWin / 2, pFail = loss + halfLoss / 2;
  return { line, win: r3(win), halfWin: r3(halfWin), push: r3(push), halfLoss: r3(halfLoss), loss: r3(loss),
    pCover: r3(pCover), fairOdds: Math.min(99, Math.round((1 + pFail / Math.max(pCover, 1e-9)) * 100) / 100) };
}

export interface LeagueAvg { home: number; away: number }
/** Rata-rata gol liga, dihaluskan dengan prior 1.45 / 1.15 gol agar aman di awal musim. */
export function leagueAverages(rows: any[]): LeagueAvg {
  let hg = 0, hp = 0, ag = 0, ap = 0;
  for (const r of rows) { hg += r.home?.goals?.for ?? 0; hp += r.home?.played ?? 0; ag += r.away?.goals?.for ?? 0; ap += r.away?.played ?? 0; }
  const K = 10;
  return { home: (hg + 1.45 * K) / (hp + K), away: (ag + 1.15 * K) / (ap + K) };
}

const g = (x: any) => ({ p: x?.played ?? 0, gf: x?.goals?.for ?? 0, ga: x?.goals?.against ?? 0 });
const ratio = (x: number, p: number, base: number) => (p > 0 ? x / p / base : 1);
const shrink = (v: number, n: number, K = 6) => 1 + (n / (n + K)) * (v - 1);
function strength(r: any, lg: LeagueAvg, side: 'home' | 'away') {
  const s = g(r[side]), t = g(r.all), avg = (lg.home + lg.away) / 2;
  const own = side === 'home' ? lg.home : lg.away, opp = side === 'home' ? lg.away : lg.home;
  const att = 0.5 * ratio(s.gf, s.p, own) + 0.5 * ratio(t.gf, t.p, avg);
  const def = 0.5 * ratio(s.ga, s.p, opp) + 0.5 * ratio(t.ga, t.p, avg);
  return { att: shrink(att, t.p), def: shrink(def, t.p), n: t.p };
}
export function formScore(f?: string | null): number {
  if (!f) return 0; const c = f.slice(-5); if (!c.length) return 0;
  let s = 0; for (const ch of c) s += ch === 'W' ? 1 : ch === 'L' ? -1 : 0; return s / c.length;
}

export function expectedGoals(homeRow: any, awayRow: any, lg: LeagueAvg) {
  const H = strength(homeRow, lg, 'home'), A = strength(awayRow, lg, 'away');
  const fd = formScore(homeRow.form) - formScore(awayRow.form);
  const lh = clamp(lg.home * H.att * A.def * (1 + 0.03 * fd), 0.2, 4.5);
  const la = clamp(lg.away * A.att * H.def * (1 - 0.03 * fd), 0.2, 4.5);
  return { lh, la, minGames: Math.min(H.n, A.n) };
}

export function buildPrediction(fx: any, homeRow: any, awayRow: any, lg: LeagueAvg): Prediction {
  const { lh, la, minGames } = expectedGoals(homeRow, awayRow, lg);
  const m = scoreMatrix(lh, la);
  let ph = 0, pd = 0, pa = 0, btts = 0; const tot = new Array(2 * MAXG + 1).fill(0); const cells: { s: string; p: number }[] = [];
  for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) {
    const p = m[i][j];
    if (i > j) ph += p; else if (i === j) pd += p; else pa += p;
    if (i > 0 && j > 0) btts += p; tot[i + j] += p; cells.push({ s: `${i}-${j}`, p });
  }
  const over = (line: number) => tot.reduce((a, p, t) => a + (t > line ? p : 0), 0);
  const ou = [1.5, 2.5, 3.5].map(line => ({ line, over: r3(over(line)), under: r3(1 - over(line)) }));
  const topScores = cells.sort((a, b) => b.p - a.p).slice(0, 5).map(c => ({ score: c.s, p: r3(c.p) }));

  const all: AHLine[] = []; for (let l = -2.5; l <= 2.5 + 1e-9; l += 0.25) all.push(ahLine(m, Math.round(l * 4) / 4));
  const edge = (a: AHLine) => Math.abs(a.pCover - (a.loss + a.halfLoss / 2));
  const fairHandicap = all.reduce((b, a) => (edge(a) < edge(b) ? a : b)).line;
  const handicap = all.filter(a => Math.abs(a.line) <= 1.5);

  const maxP = Math.max(ph, pd, pa);
  const dataQ = clamp(minGames / 10, 0, 1);
  const confidence = Math.round(100 * clamp((maxP - 0.34) / 0.5, 0, 1) * (0.5 + 0.5 * dataQ));
  const confidenceLevel = confidence >= 50 ? 'high' : confidence >= 30 ? 'medium' : 'low';
  const hn = fx.teams.home.name as string, an = fx.teams.away.name as string;
  const result = maxP === ph ? `${hn} menang` : maxP === pa ? `${an} menang` : 'Seri';
  const o25 = ou[1];
  const team = (t: any, row: any) => ({ id: t.id, name: t.name, logo: t.logo, rank: row.rank ?? null, form: row.form ?? null, played: row.all?.played ?? 0 });

  return {
    id: fx.fixture.id, kickoff: new Date(fx.fixture.timestamp * 1000).toISOString(), timestamp: fx.fixture.timestamp,
    league: { id: fx.league.id, name: fx.league.name, country: fx.league.country, logo: fx.league.logo, round: fx.league.round, season: fx.league.season },
    home: team(fx.teams.home, homeRow), away: team(fx.teams.away, awayRow),
    xg: { home: r3(lh), away: r3(la) },
    probs: { home: r3(ph), draw: r3(pd), away: r3(pa) },
    fairOdds: { home: odds(ph), draw: odds(pd), away: odds(pa) },
    doubleChance: { hx: r3(ph + pd), xa: r3(pd + pa), ha: r3(ph + pa) },
    ou, btts: { yes: r3(btts), no: r3(1 - btts) }, topScores, handicap, fairHandicap,
    confidence, confidenceLevel,
    picks: { result, goals: o25.over >= 0.5 ? 'Over 2.5' : 'Under 2.5' },
    aiSummary: 'AI analysis unavailable.',
  };
}
