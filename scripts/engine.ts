import type { Prediction, AHLine, Absence } from '../shared/types.ts';
import { CFG } from './config.ts';

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

function baseMatrix(lh: number, la: number, rho: number): number[][] {
  const m: number[][] = [];
  for (let i = 0; i <= MAXG; i++) {
    m[i] = [];
    for (let j = 0; j <= MAXG; j++) {
      let t = 1;
      if (i === 0 && j === 0) t = 1 - lh * la * rho;
      else if (i === 0 && j === 1) t = 1 + lh * rho;
      else if (i === 1 && j === 0) t = 1 + la * rho;
      else if (i === 1 && j === 1) t = 1 - rho;
      m[i][j] = Math.max(0, pois(i, lh) * pois(j, la) * t);
    }
  }
  return m;
}
/** Matriks skor:
 *  (a) Dixon-Coles untuk skor rendah,
 *  (b) campuran tempo: 3 skenario (sepi / normal / terbuka) yang membagi kedua tim sama-rata -> gol berkorelasi & ekor total gol lebih realistis
 *      (Poisson murni terlalu "sempit"), rata-rata xG dijaga tetap,
 *  (c) inflasi diagonal (seri): terbesar saat kedua tim seimbang, memudar bila selisih kekuatan besar. */
export function scoreMatrix(lh: number, la: number, rho = CFG.rho, drawBoost = CFG.drawBoost, spread = CFG.tempoSpread): number[][] {
  const sc = [{ f: Math.exp(-spread), w: 0.3 }, { f: 1, w: 0.4 }, { f: Math.exp(spread), w: 0.3 }];
  const norm = sc.reduce((a, t) => a + t.f * t.w, 0);
  const acc: number[][] = Array.from({ length: MAXG + 1 }, () => new Array(MAXG + 1).fill(0));
  for (const t of sc) {
    const b = baseMatrix(lh * t.f / norm, la * t.f / norm, rho), z = b.flat().reduce((a, x) => a + x, 0);
    for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) acc[i][j] += t.w * b[i][j] / z;
  }
  const k = drawBoost * Math.exp(-Math.pow(lh - la, 2) / 1.5);
  let s = 0;
  for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) { if (i === j) acc[i][j] *= 1 + k; s += acc[i][j]; }
  return acc.map(r => r.map(p => p / s));
}

/** Keputusan 1X2. Seri dipilih bila laga seimbang (selisih menang-kalah kecil dan seri cukup besar) atau seri nyaris teratas.
 *  Tanpa aturan ini seri hampir tidak pernah jadi "maksimum" walau di laga seimbang. */
export function decide1x2(ph: number, pd: number, pa: number): '1' | 'X' | '2' {
  const top = Math.max(ph, pa), gap = Math.abs(ph - pa);
  if ((gap < 0.07 && pd >= 0.25) || pd >= top - 0.03) return 'X';
  return ph > pa ? '1' : '2';
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

export interface EloInfo { home: number; away: number; neutral?: boolean }
/** xG murni dari selisih Elo: rasio gol = exp(slope * selisih). Netral -> total gol dibagi rata; klub/kandang memakai rata-rata liga (sudah memuat keunggulan kandang). */
export function eloExpectedGoals(e: EloInfo, lg: LeagueAvg) {
  const T = lg.home + lg.away, x = CFG.eloSlope * (e.home - e.away);
  const bh = e.neutral ? T / 2 : lg.home, ba = e.neutral ? T / 2 : lg.away;
  return { lh: clamp(bh * Math.exp(x), 0.2, 4.5), la: clamp(ba * Math.exp(-x), 0.2, 4.5) };
}

/** Dampak absen pada [kekuatan serang sendiri, kelemahan bertahan sendiri] per pemain (pecahan xG). Konservatif & dibatasi 15% per tim.
 *  Pemain "doubt" berbobot 0.4. Peran tak diketahui (data API tanpa posisi) hanya 0.8%. */
const IMPACT: Record<string, Record<string, [number, number]>> = {
  FWD: { key: [0.06, 0], starter: [0.03, 0], rotation: [0.005, 0] },
  MID: { key: [0.025, 0.02], starter: [0.012, 0.01], rotation: [0.003, 0.002] },
  DEF: { key: [0, 0.04], starter: [0, 0.02], rotation: [0, 0.004] },
  GK: { key: [0, 0.06], starter: [0, 0.04], rotation: [0, 0.005] },
};
export function absenceImpact(list?: Absence[]) {
  let att = 0, def = 0;
  for (const a of list ?? []) {
    const [x, y] = a.role === 'unknown' ? [0.008, 0.008] : IMPACT[a.pos === '?' ? 'MID' : a.pos]?.[a.role] ?? [0, 0];
    const w = a.status === 'doubt' ? 0.4 : 1; att += x * w; def += y * w;
  }
  return { att: Math.min(att, 0.15), def: Math.min(def, 0.15) };
}
type AbsIn = { home: Absence[]; away: Absence[]; source: 'ai' | 'api' | 'both'; checked: boolean };

export function buildPrediction(fx: any, homeRow: any | null, awayRow: any | null, lg: LeagueAvg, elo?: EloInfo | null, abs?: AbsIn | null): Prediction {
  let lh: number, la: number, minGames = 0, eloOnly = false;
  if (homeRow && awayRow) {
    const s = expectedGoals(homeRow, awayRow, lg); lh = s.lh; la = s.la; minGames = s.minGames;
    if (elo) { // gabung di ruang logaritma: bobot klasemen naik seiring jumlah laga
      const e = eloExpectedGoals(elo, lg), w = minGames / (minGames + CFG.eloShrinkK);
      lh = Math.exp(w * Math.log(lh) + (1 - w) * Math.log(e.lh)); la = Math.exp(w * Math.log(la) + (1 - w) * Math.log(e.la));
    }
  } else if (elo) { const e = eloExpectedGoals(elo, lg); lh = e.lh; la = e.la; eloOnly = true; }
  else throw new Error('buildPrediction: tidak ada data klasemen maupun Elo');
  let adj: { home: number; away: number } | undefined;
  if (abs && (abs.home.length || abs.away.length)) {
    const H = absenceImpact(abs.home), A = absenceImpact(abs.away), h0 = lh, a0 = la;
    lh = clamp(lh * (1 - H.att) * (1 + A.def), 0.2, 4.5); la = clamp(la * (1 - A.att) * (1 + H.def), 0.2, 4.5);
    adj = { home: r3(lh / h0 - 1), away: r3(la / a0 - 1) };
  }
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

  const pick = decide1x2(ph, pd, pa), maxP = Math.max(ph, pd, pa);
  const aiPenalty = homeRow?.source === 'ai' || awayRow?.source === 'ai' ? 0.6 : 1; // data AI belum terverifikasi -> keyakinan turun
  const dataQ = eloOnly ? CFG.eloOnlyPenalty * 0.7 : clamp(minGames / 10 + (elo ? 0.3 : 0), 0, 1) * aiPenalty;
  const confidence = Math.round(100 * clamp((maxP - 0.34) / 0.5, 0, 1) * (0.5 + 0.5 * dataQ));
  const confidenceLevel = confidence >= 50 ? 'high' : confidence >= 30 ? 'medium' : 'low';
  const hn = fx.teams.home.name as string, an = fx.teams.away.name as string;
  const result = pick === '1' ? `${hn} menang` : pick === '2' ? `${an} menang` : 'Seri';
  // "Aman" = double chance dengan peluang tertinggi (tidak memasangkan 1 & 2 kecuali seri sangat kecil)
  const dcs = [{ t: `${hn} / Seri`, p: ph + pd }, { t: `Seri / ${an}`, p: pd + pa }, { t: `${hn} / ${an}`, p: ph + pa - 0.12 }];
  const safe = dcs.reduce((b, x) => (x.p > b.p ? x : b));
  const o25 = ou[1];
  const team = (t: any, row: any | null, e?: number) => ({ id: t.id, name: t.name, logo: t.logo, rank: row?.rank ?? null, form: row?.form ?? null, played: row?.all?.played ?? 0, dataSource: row ? row.source : 'elo', elo: e ? Math.round(e) : null });

  return {
    id: fx.fixture.id, kickoff: new Date(fx.fixture.timestamp * 1000).toISOString(), timestamp: fx.fixture.timestamp,
    league: { id: fx.league.id, name: fx.league.name, country: fx.league.country, logo: fx.league.logo, round: fx.league.round, season: fx.league.season },
    home: team(fx.teams.home, eloOnly ? null : homeRow, elo?.home), away: team(fx.teams.away, eloOnly ? null : awayRow, elo?.away),
    xg: { home: r3(lh), away: r3(la) },
    probs: { home: r3(ph), draw: r3(pd), away: r3(pa) },
    fairOdds: { home: odds(ph), draw: odds(pd), away: odds(pa) },
    doubleChance: { hx: r3(ph + pd), xa: r3(pd + pa), ha: r3(ph + pa) },
    ou, btts: { yes: r3(btts), no: r3(1 - btts) }, topScores, handicap, fairHandicap,
    confidence, confidenceLevel,
    picks: { result, pick1x2: pick, goals: o25.over >= 0.5 ? 'Over 2.5' : 'Under 2.5', safe: `${safe.t} (${Math.round(Math.min(safe.p, 1) * 100)}%)` },
    aiSummary: 'AI analysis unavailable.',
    absences: abs && adj ? { ...abs, adj } : undefined,
  };
}
