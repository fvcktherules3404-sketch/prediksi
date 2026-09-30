import type { Prediction, AHLine, Absence, MarketInfo, Probs3, MatchContext } from '../shared/types.ts';
import { CFG } from './config.ts';
import { type TableCtx, stakeMultipliers } from './stakes.ts';

/** ===== MESIN STATISTIK DETERMINISTIK (tanpa AI) =====
 * 1. Kekuatan serang/bertahan dari klasemen (split kandang/tandang + keseluruhan)
 * 2. Shrinkage Bayesian ke rata-rata liga (sampel kecil tidak ekstrem)
 * 3. Penyesuaian form 5 laga terakhir (maks ±3%)
 * 4. Poisson + koreksi Dixon-Coles untuk skor rendah
 * 5. Matriks skor -> 1X2, Over/Under, BTTS, Handicap Asia (termasuk seperempat), fair odds
 * 6. (v2) Penggabungan dengan probabilitas pasar (odds bandar tanpa margin) di ruang log, lalu xG DIFIT ULANG agar seluruh
 *    turunan (skor, O/U, BTTS, handicap) konsisten dengan 1X2 hasil gabungan. Temperatur (ketajaman) hasil kalibrasi rekam jejak.
 * 7. (v2) Keyakinan = ketegasan peluang x kualitas data x kesepakatan model-pasar x jenis laga.
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
/** Pick 1X2. Default = tim dengan peluang menang tertinggi. Seri hanya dipilih bila (a) peluang seri memang tertinggi, atau
 *  (b) laga nyaris kembar (selisih kandang-tandang < 3 poin persen) dan seri >= 28%.
 *  Backtest (klub 23k laga, timnas 45k laga): aturan lama (selisih < 7 poin & seri >= 25%) menurunkan akurasi 0,6-1,1 poin;
 *  aturan ketat ini setara dengan "selalu pilih tim" (selisih < 0,3 poin, dalam galat) dan Seri terpilih hanya 2-6% laga. */
export const DRAW_PICK_GAP = 0.03, DRAW_PICK_MIN = 0.28;
export function decide1x2(ph: number, pd: number, pa: number): '1' | 'X' | '2' {
  if (pd > ph && pd > pa) return 'X';
  if (Math.abs(ph - pa) < DRAW_PICK_GAP && pd >= DRAW_PICK_MIN) return 'X';
  return ph >= pa ? '1' : '2';
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

export interface EloInfo { home: number; away: number; neutral?: boolean; fromMarket?: boolean }
/** xG murni dari selisih Elo: rasio gol = exp(slope * selisih). Netral -> total gol dibagi rata; klub/kandang memakai rata-rata liga (sudah memuat keunggulan kandang). */
export function eloExpectedGoals(e: EloInfo, lg: LeagueAvg) {
  const T = lg.home + lg.away, x = CFG.eloSlope * (e.home - e.away);
  const bh = e.neutral ? T / 2 : lg.home, ba = e.neutral ? T / 2 : lg.away;
  return { lh: clamp(bh * Math.exp(x), 0.2, 4.5), la: clamp(ba * Math.exp(-x), 0.2, 4.5) };
}

/** Laga tanpa klasemen & tanpa Elo tetapi punya odds: cari selisih \"Elo semu\" yang membuat model (Poisson) menghasilkan P(kandang)-P(tandang) sama dengan pasar.
 *  Hasil akhirnya praktis = pasar (pasar memang satu-satunya informasi). Ditandai fromMarket agar keyakinan dipotong dan lencana \"Pasar\" tampil. */
export function marketElo(mk: { home: number; away: number }, lg: LeagueAvg): EloInfo {
  const target = mk.home - mk.away;
  const diffAt = (d: number) => { const e = eloExpectedGoals({ home: 1500 + d / 2, away: 1500 - d / 2 }, lg), s = matrixStats(scoreMatrix(e.lh, e.la)); return s.ph - s.pa; };
  let lo = -1200, hi = 1200;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (diffAt(mid) < target) lo = mid; else hi = mid; }
  const d = (lo + hi) / 2;
  return { home: 1500 + d / 2, away: 1500 - d / 2, neutral: false, fromMarket: true };
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

export interface Ext { market?: MarketInfo | null; marketW?: number; tau?: number; table?: TableCtx | null; ctx?: MatchContext | null }
type T3 = [number, number, number];

/** Statistik dari matriks skor: peluang 1X2 dan Over 2.5. */
export function matrixStats(m: number[][]) {
  let ph = 0, pd = 0, pa = 0, o25 = 0;
  for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) { const p = m[i][j]; if (i > j) ph += p; else if (i === j) pd += p; else pa += p; if (i + j >= 3) o25 += p; }
  return { ph, pd, pa, o25 };
}
/** Rata-rata geometrik berbobot (ruang log): hasil ∝ a^(1-w) · b^w. */
export function geoBlend(a: T3, b: T3, w: number): T3 {
  const x = a.map((v, i) => Math.pow(Math.max(v, 1e-6), 1 - w) * Math.pow(Math.max(b[i], 1e-6), w)), z = x.reduce((s, v) => s + v, 0);
  return x.map(v => v / z) as T3;
}
/** Temperatur: p ∝ p^tau. tau>1 lebih tajam, tau<1 lebih landai. */
export function temper(p: T3, tau: number): T3 {
  const x = p.map(v => Math.pow(Math.max(v, 1e-6), tau)), z = x.reduce((s, v) => s + v, 0);
  return x.map(v => v / z) as T3;
}
/** Cari (λ_home, λ_away) yang matriks skornya paling cocok dengan target 1X2 (+ opsional Over 2.5).
 *  Pencarian pola pada (total T, selisih d) dengan regulasi kecil agar total gol tidak menyimpang tanpa alasan. */
export function fitLambdas(lh0: number, la0: number, t: { p: T3; o25?: number }) {
  const T0 = lh0 + la0;
  const loss = (T: number, d: number) => {
    const s = matrixStats(scoreMatrix(clamp((T + d) / 2, 0.15, 5), clamp((T - d) / 2, 0.15, 5)));
    let e = (s.ph - t.p[0]) ** 2 + (s.pd - t.p[1]) ** 2 + (s.pa - t.p[2]) ** 2;
    if (t.o25 !== undefined) e += 0.5 * (s.o25 - t.o25) ** 2;
    return e + 0.01 * Math.log(T / T0) ** 2;
  };
  let T = T0, d = lh0 - la0, best = loss(T, d), sT = 0.4, sd = 0.5;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let it = 0; it < 80 && (sT > 0.004 || sd > 0.004); it++) {
    let moved = false;
    for (const [a, b] of dirs) { const nT = clamp(T + a * sT, 0.6, 8), nd = clamp(d + b * sd, -5, 5), e = loss(nT, nd); if (e < best - 1e-12) { best = e; T = nT; d = nd; moved = true; } }
    if (!moved) { sT /= 2; sd /= 2; }
  }
  return { lh: clamp((T + d) / 2, 0.2, 4.5), la: clamp((T - d) / 2, 0.2, 4.5), err: best };
}

export function buildPrediction(fx: any, homeRow: any | null, awayRow: any | null, lg: LeagueAvg, elo?: EloInfo | null, abs?: AbsIn | null, ext?: Ext): Prediction {
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

  // --- v3: taruhan laga. Label situasi selalu dihitung bila tabel tersedia; pengali xG hanya bila CFG.stakesOn (bukti: backtest.ts bagian H) ---
  let stakes: Prediction['stakes'];
  if (ext?.table) {
    const on = CFG.stakesOn, m = stakeMultipliers(ext.table, on ? { rel: CFG.stakesRel, level: CFG.stakesLevel, phase: CFG.stakesPhase, need0: CFG.stakesNeed0 } : { rel: 0, level: 0, phase: 0, need0: CFG.stakesNeed0 });
    const h0 = lh, a0 = la; lh = clamp(lh * m.home, 0.2, 4.5); la = clamp(la * m.away, 0.2, 4.5);
    const pick = (s: typeof m.sitH) => ({ kind: s.kind, need: r3(s.need), defending: s.defending, label: s.label });
    stakes = { home: pick(m.sitH), away: pick(m.sitA), phase: r3(m.phase), adj: { home: r3(lh / h0 - 1), away: r3(la / a0 - 1) } };
  }

  // --- v5: konteks laga (final, derbi, leg 2, kelelahan, grup timnas). Pengali sudah dihitung scripts/context.ts ---
  let context: Prediction['context'];
  if (ext?.ctx) {
    lh = clamp(lh * ext.ctx.mul.home, 0.2, 4.5); la = clamp(la * ext.ctx.mul.away, 0.2, 4.5);
    context = { ...ext.ctx, mul: { home: r3(ext.ctx.mul.home), away: r3(ext.ctx.mul.away) }, confFactor: r3(ext.ctx.confFactor) };
  }

  // --- Model murni -> (opsional) gabung pasar -> (opsional) temperatur -> fit ulang xG ---
  let m = scoreMatrix(lh, la);
  const s0 = matrixStats(m), model3: T3 = [s0.ph, s0.pd, s0.pa];
  const market = ext?.market ?? null, tau = clamp(ext?.tau ?? 1, CFG.tauMin, CFG.tauMax);
  let mw = 0, p3: T3 = model3, o25t: number | undefined;
  if (market) {
    mw = clamp(ext?.marketW ?? CFG.marketWeight, 0, 0.95) * (market.books >= 3 ? 1 : 0.7); // sedikit bandar -> pasar kurang dipercaya
    p3 = geoBlend(model3, [market.home, market.draw, market.away], mw);
    if (market.over25 !== undefined) o25t = (1 - mw) * s0.o25 + mw * market.over25;
  }
  const raw3: T3 = p3;
  if (Math.abs(tau - 1) > 1e-9) p3 = temper(p3, tau);
  if (market || Math.abs(tau - 1) > 1e-9) { const f = fitLambdas(lh, la, { p: p3, o25: o25t }); lh = f.lh; la = f.la; m = scoreMatrix(lh, la); }

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
  // --- Keyakinan v2: ketegasan x kualitas data x kesepakatan model-pasar x jenis laga ---
  const aiData = homeRow?.source === 'ai' || awayRow?.source === 'ai';
  let q = 0.30 + (elo && !elo.fromMarket ? 0.25 : 0) + 0.25 * clamp(minGames / 15, 0, 1) + (market ? 0.25 * Math.min(1, market.books / 3) : 0);
  if (aiData) q *= 0.6; // data AI belum terverifikasi
  if (elo?.fromMarket) q *= CFG.marketOnlyQualityFactor; // tidak ada model independen, hanya odds
  q = clamp(q, 0, 1);
  let agreement = 1;
  if (market) {
    const tv = 0.5 * (Math.abs(model3[0] - market.home) + Math.abs(model3[1] - market.draw) + Math.abs(model3[2] - market.away));
    agreement = 1 - clamp((tv - 0.05) * 1.5, 0, 0.35);
    if (decide1x2(model3[0], model3[1], model3[2]) !== decide1x2(market.home, market.draw, market.away)) agreement *= 0.9;
  }
  const comp = (CFG.friendlyLeagues.has(fx.league.id) ? CFG.friendlyConfFactor : 1) * (ext?.ctx?.confFactor ?? 1);
  const core = clamp((maxP - 0.34) / 0.5, 0, 1);
  const confidence = Math.round(100 * core * (0.5 + 0.5 * q) * agreement * comp);
  const confidenceLevel = confidence >= 50 ? 'high' : confidence >= 30 ? 'medium' : 'low';
  const hn = fx.teams.home.name as string, an = fx.teams.away.name as string;
  const result = pick === '1' ? `${hn} menang` : pick === '2' ? `${an} menang` : 'Seri';
  // "Aman" = double chance dengan peluang tertinggi (tidak memasangkan 1 & 2 kecuali seri sangat kecil)
  const dcs = [{ t: `${hn} / Seri`, p: ph + pd }, { t: `Seri / ${an}`, p: pd + pa }, { t: `${hn} / ${an}`, p: ph + pa - 0.12 }];
  const safe = dcs.reduce((b, x) => (x.p > b.p ? x : b));
  const o25 = ou[1];
  const team = (t: any, row: any | null, e?: number) => ({ id: t.id, name: t.name, logo: t.logo, rank: row?.rank ?? null, form: row?.form ?? null, played: row?.all?.played ?? 0, dataSource: row ? row.source : elo?.fromMarket ? 'market' : 'elo', elo: e && !elo?.fromMarket ? Math.round(e) : null });
  const P3 = (a: T3): Probs3 => ({ home: r3(a[0]), draw: r3(a[1]), away: r3(a[2]) });

  return {
    id: fx.fixture.id, kickoff: new Date(fx.fixture.timestamp * 1000).toISOString(), timestamp: fx.fixture.timestamp,
    league: { id: fx.league.id, name: fx.league.name, country: fx.league.country, logo: fx.league.logo, round: fx.league.round, season: fx.league.season },
    home: team(fx.teams.home, eloOnly ? null : homeRow, elo?.home), away: team(fx.teams.away, eloOnly ? null : awayRow, elo?.away),
    xg: { home: r3(lh), away: r3(la) },
    probs: { home: r3(ph), draw: r3(pd), away: r3(pa) },
    fairOdds: { home: odds(ph), draw: odds(pd), away: odds(pa) },
    doubleChance: { hx: r3(ph + pd), xa: r3(pd + pa), ha: r3(ph + pa) },
    ou, btts: { yes: r3(btts), no: r3(1 - btts) }, topScores, handicap, fairHandicap,
    confidence, confidenceLevel, conf: { core: r3(core), quality: r3(q), agreement: r3(agreement), comp: r3(comp) },
    picks: { result, pick1x2: pick, goals: o25.over >= 0.5 ? 'Over 2.5' : 'Under 2.5', safe: `${safe.t} (${Math.round(Math.min(safe.p, 1) * 100)}%)` },
    aiSummary: 'AI analysis unavailable.',
    absences: abs && adj ? { ...abs, adj } : undefined,
    stakes, context,
    modelProbs: P3(model3), rawProbs: P3(raw3), market: market ?? undefined, calib: { tau, marketW: r3(mw) },
  };
}