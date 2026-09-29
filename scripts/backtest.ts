import fs from 'node:fs';
import path from 'node:path';
import { CFG } from './config.ts';
import { scoreMatrix, matrixStats, expectedGoals, eloExpectedGoals, leagueAverages, decide1x2, geoBlend, temper, MAXG } from './engine.ts';
import { devig } from './odds.ts';

/** ===== BACKTEST WALK-FORWARD =====
 * Menguji mesin (engine.ts) pada ribuan laga lama, tanpa menunggu rekam jejak live.
 * Data: CSV gratis dari football-data.co.uk (hasil + odds), taruh di data/backtest/ (lihat docs/BACKTEST.md).
 * Tiap laga diprediksi HANYA dari laga sebelumnya (tanpa mengintip masa depan):
 *   - model klasemen  : expectedGoals() milik engine (statistik gol musim berjalan, shrinkage, form)
 *   - model Elo       : Elo dihitung sendiri dari hasil (bukan ClubElo, tapi skalanya sama) -> eloExpectedGoals()
 *   - gabungan        : bobot klasemen = laga/(laga+eloShrinkK), persis seperti buildPrediction()
 *   - pasar           : odds bandar tanpa margin (devig) -> geoBlend + temper, persis seperti engine
 * Parameter dituning pada 70% laga pertama (menurut waktu) dan DIUJI pada 30% terakhir, supaya tidak menipu diri sendiri (overfitting).
 * Hanya 1X2 yang dituning. O/U 2.5 dan BTTS hanya dilaporkan. Pakai: npm run backtest -- --dir=data/backtest */

type T3 = [number, number, number];
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? 'true']; }));
const DIR = String(args.dir ?? 'data/backtest'), WARMUP = Number(args.warmup ?? 20), SPLIT = Number(args.split ?? 0.7), CLOSING = args.closing === 'true';
const REPORT = String(args.out ?? 'data/backtest-report.json');

// ---------------------------------------------------------------- CSV
function splitLine(line: string): string[] {
  const out: string[] = []; let cur = '', q = false;
  for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; }
  out.push(cur); return out.map(s => s.trim());
}
export function parseDate(s: string): number | null {
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) { const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]); return Date.UTC(y, Number(m[2]) - 1, Number(m[1])); }
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
const num = (x: string | undefined) => { const v = Number(x); return x !== undefined && x !== '' && Number.isFinite(v) ? v : NaN; };

// Urutan prioritas odds. Default: odds SEBELUM penutupan (mirip waktu pengambilan di aplikasi). --closing=true: pakai odds penutupan (lebih tajam, batas atas).
const ODDS_PRE = [['PSH', 'PSD', 'PSA'], ['B365H', 'B365D', 'B365A'], ['AvgH', 'AvgD', 'AvgA'], ['PH', 'PD', 'PA']];
const ODDS_CLOSE = [['PSCH', 'PSCD', 'PSCA'], ['AvgCH', 'AvgCD', 'AvgCA'], ['B365CH', 'B365CD', 'B365CA']];
const OU_PRE = [['P>2.5', 'P<2.5'], ['Avg>2.5', 'Avg<2.5'], ['B365>2.5', 'B365<2.5']], OU_CLOSE = [['PC>2.5', 'PC<2.5'], ['AvgC>2.5', 'AvgC<2.5']];

interface Match { t: number; leagueKey: string; group: string; home: string; away: string; hg: number; ag: number; mkt?: T3; mktO25?: number }
export function loadCsv(file: string): Match[] {
  const txt = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (txt.length < 2) return [];
  const head = splitLine(txt[0]), idx = (...names: string[]) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
  const iD = idx('Date'), iH = idx('HomeTeam', 'Home'), iA = idx('AwayTeam', 'Away'), iHG = idx('FTHG', 'HG'), iAG = idx('FTAG', 'AG'), iLg = idx('League'), iSe = idx('Season'), iDiv = idx('Div');
  if ([iD, iH, iA, iHG, iAG].some(i => i < 0)) { console.warn(`[lewati] ${path.basename(file)}: kolom Date/HomeTeam/AwayTeam/FTHG/FTAG tidak lengkap`); return []; }
  const base = path.basename(file).replace(/\.csv$/i, ''), nm = /^(.+?)[-_ ](\d.*)$/.exec(base);
  const fileLeague = nm ? nm[1] : base, fileSeason = nm ? nm[2] : '';
  const oddsSets = (CLOSING ? [...ODDS_CLOSE, ...ODDS_PRE] : [...ODDS_PRE, ...ODDS_CLOSE]).map(c => c.map(x => head.indexOf(x))).filter(ix => ix.every(i => i >= 0));
  const ouSets = (CLOSING ? [...OU_CLOSE, ...OU_PRE] : [...OU_PRE, ...OU_CLOSE]).map(c => c.map(x => head.indexOf(x))).filter(ix => ix.every(i => i >= 0));
  const out: Match[] = [];
  for (const line of txt.slice(1)) {
    const c = splitLine(line), t = parseDate(c[iD] ?? ''), hg = num(c[iHG]), ag = num(c[iAG]);
    if (t === null || !c[iH] || !c[iA] || !Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    const leagueKey = iLg >= 0 ? c[iLg] : iDiv >= 0 && c[iDiv] ? c[iDiv] : fileLeague, season = iSe >= 0 ? c[iSe] : fileSeason;
    const m: Match = { t, leagueKey, group: `${leagueKey}|${season}`, home: c[iH], away: c[iA], hg, ag };
    for (const ix of oddsSets) { const p = devig(ix.map(i => num(c[i]))); if (p) { m.mkt = [p[0], p[1], p[2]]; break; } }
    for (const ix of ouSets) { const p = devig(ix.map(i => num(c[i])), 1.2); if (p) { m.mktO25 = p[0]; break; } }
    out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------- Walk-forward: statistik klasemen + Elo
interface Rec { t: number; out: 0 | 1 | 2; hg: number; ag: number; n: number; lg: { home: number; away: number }; xS: [number, number]; xN: [number, number]; ed: number; mkt?: T3; mktO25?: number }
interface TeamS { p: number; gf: number; ga: number; hp: number; hgf: number; hga: number; ap: number; agf: number; aga: number; form: string }
const blank = (): TeamS => ({ p: 0, gf: 0, ga: 0, hp: 0, hgf: 0, hga: 0, ap: 0, agf: 0, aga: 0, form: '' });
const toRow = (s: TeamS, noForm = false) => ({ form: noForm ? '' : s.form, all: { played: s.p, goals: { for: s.gf, against: s.ga } }, home: { played: s.hp, goals: { for: s.hgf, against: s.hga } }, away: { played: s.ap, goals: { for: s.agf, against: s.aga } } });

export function walkForward(matches: Match[], warmup: number): Rec[] {
  const ms = [...matches].sort((a, b) => a.t - b.t);
  const stand = new Map<string, Map<string, TeamS>>(), tot = new Map<string, { hg: number; hp: number; ag: number; ap: number }>();
  const elo = new Map<string, number>(), cnt = new Map<string, number>(), seenGroup = new Set<string>();
  const recs: Rec[] = [], HA = 60;
  for (let i = 0; i < ms.length;) {
    let j = i; while (j < ms.length && ms[j].t === ms[i].t) j++;
    const day = ms.slice(i, j); i = j;
    for (const m of day) { // awal musim baru: tarik Elo tim liga itu 25% ke 1500
      if (!seenGroup.has(m.group)) { seenGroup.add(m.group); for (const [k, v] of elo) if (k.startsWith(m.leagueKey + '|')) elo.set(k, 1500 + 0.75 * (v - 1500)); }
    }
    // 1) prediksi semua laga hari itu dari data SEBELUM hari itu
    for (const m of day) {
      const g = stand.get(m.group) ?? new Map<string, TeamS>(), H = g.get(m.home) ?? blank(), A = g.get(m.away) ?? blank();
      const T = tot.get(m.group) ?? { hg: 0, hp: 0, ag: 0, ap: 0 };
      const lg = leagueAverages([{ home: { played: T.hp, goals: { for: T.hg } }, away: { played: T.ap, goals: { for: T.ag } } }]);
      const kH = `${m.leagueKey}|${m.home}`, kA = `${m.leagueKey}|${m.away}`, eh = elo.get(kH) ?? 1500, ea = elo.get(kA) ?? 1500;
      if (Math.min(cnt.get(kH) ?? 0, cnt.get(kA) ?? 0) >= warmup) {
        const s = expectedGoals(toRow(H), toRow(A), lg), s0 = expectedGoals(toRow(H, true), toRow(A, true), lg);
        recs.push({ t: m.t, out: m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2, hg: m.hg, ag: m.ag, n: s.minGames, lg, xS: [s.lh, s.la], xN: [s0.lh, s0.la], ed: eh - ea, mkt: m.mkt, mktO25: m.mktO25 });
      }
    }
    // 2) baru sesudah itu perbarui statistik dan Elo
    for (const m of day) {
      const g = stand.get(m.group) ?? new Map<string, TeamS>(); stand.set(m.group, g);
      const H = g.get(m.home) ?? blank(), A = g.get(m.away) ?? blank(); g.set(m.home, H); g.set(m.away, A);
      H.p++; H.gf += m.hg; H.ga += m.ag; H.hp++; H.hgf += m.hg; H.hga += m.ag; H.form = (H.form + (m.hg > m.ag ? 'W' : m.hg === m.ag ? 'D' : 'L')).slice(-5);
      A.p++; A.gf += m.ag; A.ga += m.hg; A.ap++; A.agf += m.ag; A.aga += m.hg; A.form = (A.form + (m.ag > m.hg ? 'W' : m.hg === m.ag ? 'D' : 'L')).slice(-5);
      const T = tot.get(m.group) ?? { hg: 0, hp: 0, ag: 0, ap: 0 }; T.hg += m.hg; T.hp++; T.ag += m.ag; T.ap++; tot.set(m.group, T);
      const kH = `${m.leagueKey}|${m.home}`, kA = `${m.leagueKey}|${m.away}`, eh = elo.get(kH) ?? 1500, ea = elo.get(kA) ?? 1500;
      const exp = 1 / (1 + Math.pow(10, -(eh - ea + HA) / 400)), S = m.hg > m.ag ? 1 : m.hg === m.ag ? 0.5 : 0, gd = Math.abs(m.hg - m.ag);
      const K = 20 * (gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8), d = K * (S - exp);
      elo.set(kH, eh + d); elo.set(kA, ea - d); cnt.set(kH, (cnt.get(kH) ?? 0) + 1); cnt.set(kA, (cnt.get(kA) ?? 0) + 1);
    }
  }
  return recs;
}

// ---------------------------------------------------------------- Model dan metrik
interface Par { slope: number; K: number; rho: number; draw: number; spread: number; w: number; tau: number; useForm: boolean; mode: 'std' | 'elo' | 'comb' }
const P0: Par = { slope: CFG.eloSlope, K: CFG.eloShrinkK, rho: CFG.rho, draw: CFG.drawBoost, spread: CFG.tempoSpread, w: 0, tau: 1, useForm: true, mode: 'comb' };
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

function xgOf(r: Rec, p: Par): [number, number] {
  const s = p.useForm ? r.xS : r.xN;
  if (p.mode === 'std') return s;
  const old = CFG.eloSlope; CFG.eloSlope = p.slope; const e = eloExpectedGoals({ home: r.ed, away: 0 }, r.lg); CFG.eloSlope = old;
  if (p.mode === 'elo') return [e.lh, e.la];
  const w = r.n / (r.n + p.K);
  return [Math.exp(w * Math.log(s[0]) + (1 - w) * Math.log(e.lh)), Math.exp(w * Math.log(s[1]) + (1 - w) * Math.log(e.la))];
}
function matrixOf(r: Rec, p: Par) { const [lh, la] = xgOf(r, p); return scoreMatrix(lh, la, p.rho, p.draw, p.spread); }
function probs(r: Rec, p: Par, m = matrixOf(r, p)): T3 {
  const s = matrixStats(m); let q: T3 = [s.ph, s.pd, s.pa];
  if (r.mkt && p.w > 0) q = geoBlend(q, r.mkt, p.w);
  return Math.abs(p.tau - 1) > 1e-9 ? temper(q, p.tau) : q;
}
const ll = (q: T3, o: number) => -Math.log(Math.max(q[o], 1e-6));
const brier = (q: T3, o: number) => q.reduce((a, v, i) => a + (v - (i === o ? 1 : 0)) ** 2, 0);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const meanLL = (rs: Rec[], f: (r: Rec) => T3) => mean(rs.map(r => ll(f(r), r.out)));
const argmax = (q: T3) => (q[0] >= q[1] && q[0] >= q[2] ? 0 : q[2] >= q[1] ? 2 : 1);
/** Selisih log-loss berpasangan A - B (negatif = A lebih baik) beserta galat baku. */
function paired(rs: Rec[], fa: (r: Rec) => T3, fb: (r: Rec) => T3) {
  const d = rs.map(r => ll(fa(r), r.out) - ll(fb(r), r.out)), mu = mean(d), sd = Math.sqrt(mean(d.map(x => (x - mu) ** 2)) * d.length / Math.max(1, d.length - 1));
  return { d: mu, se: sd / Math.sqrt(d.length) };
}
const verdict = (x: { d: number; se: number }) => (Math.abs(x.d) < 1.96 * x.se ? 'belum berbeda nyata' : x.d < 0 ? 'A lebih baik (nyata)' : 'B lebih baik (nyata)');
const f4 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '   -  ' : x.toFixed(4));
const pct = (x: number) => (Number.isFinite(x) ? (100 * x).toFixed(1) + '%' : '-');
function argmin<T>(items: T[], f: (x: T) => number): T { let b = items[0], bv = Infinity; for (const it of items) { const v = f(it); if (v < bv) { bv = v; b = it; } } return b; }
const range = (a: number, b: number, s: number) => { const o: number[] = []; for (let x = a; x <= b + 1e-9; x += s) o.push(Math.round(x * 1e4) / 1e4); return o; };

// ---------------------------------------------------------------- Main
export function runBacktest(matches: Match[]) {
  const recs = walkForward(matches, WARMUP);
  const rep: any = { generatedAt: new Date().toISOString(), files: matches.length, evaluated: recs.length, warmup: WARMUP, closingOdds: CLOSING };
  if (recs.length < 200) { console.log(`Hanya ${recs.length} laga yang bisa dinilai (setelah warm-up ${WARMUP}). Butuh minimal ~500, idealnya 3000+. Tambah musim/liga.`); return rep; }
  const cut = Math.floor(recs.length * SPLIT), train = recs.slice(0, cut), test = recs.slice(cut);
  const withMkt = (rs: Rec[]) => rs.filter(r => r.mkt);
  console.log(`\nLaga dinilai: ${recs.length} (latih ${train.length}, uji ${test.length}) | ber-odds: ${withMkt(recs).length} | warm-up ${WARMUP} laga/tim | odds ${CLOSING ? 'PENUTUPAN' : 'pra-penutupan'}`);
  console.log(`Periode: ${new Date(recs[0].t).toISOString().slice(0, 10)} s/d ${new Date(recs[recs.length - 1].t).toISOString().slice(0, 10)}   (log-loss acak = 1.0986; makin kecil makin baik)`);
  if (recs.length < 1500) console.log('PERINGATAN: sampel < 1500, hasil tuning bisa kebetulan. Tambah musim/liga.');

  // --- A. Baseline dan perbandingan model (parameter default) ---
  const freq: T3 = [0, 1, 2].map(o => (train.filter(r => r.out === o).length + 1) / (train.length + 3)) as T3;
  const rows: [string, (r: Rec) => T3][] = [
    ['Frekuensi liga (tanpa info tim)', () => freq],
    ['Klasemen saja', r => probs(r, { ...P0, mode: 'std' })],
    ['Klasemen tanpa form', r => probs(r, { ...P0, mode: 'std', useForm: false })],
    ['Elo saja', r => probs(r, { ...P0, mode: 'elo' })],
    ['Gabungan Elo + klasemen (default)', r => probs(r, P0)],
  ];
  console.log('\nA. Model pada parameter default (set UJI):');
  console.log('   ' + 'model'.padEnd(36) + 'log-loss  Brier   akurasi');
  rep.baselines = {};
  for (const [name, f] of rows) {
    const rs = test, L = meanLL(rs, f), B = mean(rs.map(r => brier(f(r), r.out))), acc = mean(rs.map(r => +(argmax(f(r)) === r.out)));
    console.log('   ' + name.padEnd(36) + `${f4(L)}   ${f4(B)}  ${pct(acc)}`); rep.baselines[name] = { logloss: L, brier: B, acc };
  }
  const mk = withMkt(test);
  if (mk.length >= 100) {
    const f = (r: Rec) => r.mkt as T3, own = (r: Rec) => probs(r, P0);
    console.log('   ' + `Pasar (devig) [${mk.length} laga]`.padEnd(36) + `${f4(meanLL(mk, f))}   ${f4(mean(mk.map(r => brier(f(r), r.out))))}  ${pct(mean(mk.map(r => +(argmax(f(r)) === r.out))))}`);
    console.log('   ' + 'Gabungan pada laga yang sama'.padEnd(36) + `${f4(meanLL(mk, own))}`);
    const d = paired(mk, own, f); console.log(`   Model - pasar = ${d.d.toFixed(4)} ± ${(1.96 * d.se).toFixed(4)} (95%): ${verdict(d).replace('A', 'model').replace('B', 'pasar')}`);
  }

  // --- B. Tuning Elo (slope, K) pada set latih ---
  const slopes = [0.0008, 0.0010, 0.0012, 0.0014, 0.0016, 0.0018, 0.0020, 0.0024], Ks = [4, 8, 16, 30];
  const grid = slopes.flatMap(s => Ks.map(k => ({ s, k })));
  const bestE = argmin(grid, g => meanLL(train, r => probs(r, { ...P0, slope: g.s, K: g.k })));
  const bestEloOnly = argmin(slopes, s => meanLL(train, r => probs(r, { ...P0, mode: 'elo', slope: s })));
  console.log(`\nB. Tuning Elo -> xG (dipilih di set latih, dinilai di set uji):`);
  console.log(`   eloSlope terbaik (Elo saja) : ${bestEloOnly}   | gabungan: slope ${bestE.s}, eloShrinkK ${bestE.k}   (default: ${P0.slope}, ${P0.K})`);

  // --- C. Bentuk matriks skor: rho, drawBoost, tempoSpread ---
  const base1 = { ...P0, slope: bestE.s, K: bestE.k };
  const shapes = range(-0.13, -0.04, 0.03).flatMap(rho => [0, 0.04, 0.08, 0.12, 0.16].flatMap(draw => [0.1, 0.2, 0.3].map(spread => ({ rho, draw, spread }))));
  const bestS = argmin(shapes, x => meanLL(train, r => probs(r, { ...base1, ...x })));
  console.log(`C. Bentuk skor: rho ${bestS.rho}, drawBoost ${bestS.draw}, tempoSpread ${bestS.spread}   (default: ${P0.rho}, ${P0.draw}, ${P0.spread})`);
  const tuned1: Par = { ...base1, ...bestS };
  const dT = paired(test, r => probs(r, tuned1), r => probs(r, P0));
  console.log(`   Set uji: default ${f4(meanLL(test, r => probs(r, P0)))} -> tuning ${f4(meanLL(test, r => probs(r, tuned1)))} (selisih ${dT.d.toFixed(4)} ± ${(1.96 * dT.se).toFixed(4)}: ${verdict(dT).replace('A', 'tuning').replace('B', 'default')})`);

  // --- D. Pasar dan ketajaman (hanya bila cukup laga ber-odds) ---
  let final: Par = tuned1;
  const mkTrain = withMkt(train), mkTest = withMkt(test);
  if (mkTrain.length >= 200 && mkTest.length >= 100) {
    const w = argmin(range(0, 1, 0.05), x => meanLL(mkTrain, r => probs(r, { ...tuned1, w: x })));
    const tau = argmin(range(0.8, 1.4, 0.05), t => meanLL(mkTrain, r => probs(r, { ...tuned1, w, tau: t })));
    final = { ...tuned1, w, tau };
    console.log(`D. Pasar: bobot terbaik marketWeight ${w} (aplikasi memakai ${CFG.marketWeight}); ketajaman tau ${tau}`);
    for (const [nm, p] of [['model murni', tuned1], ['aplikasi (w=' + CFG.marketWeight + ')', { ...tuned1, w: CFG.marketWeight }], ['terbaik (w=' + w + ', tau=' + tau + ')', final]] as [string, Par][])
      console.log(`   uji ber-odds, ${nm.padEnd(26)} log-loss ${f4(meanLL(mkTest, r => probs(r, p)))}`);
    const dm = paired(mkTest, r => probs(r, final), r => r.mkt as T3);
    console.log(`   terbaik vs pasar murni: ${dm.d.toFixed(4)} ± ${(1.96 * dm.se).toFixed(4)} -> ${verdict(dm).replace('A', 'gabungan').replace('B', 'pasar murni')}`);
    rep.market = { marketW: w, tau };
  } else console.log('D. Pasar: laga ber-odds terlalu sedikit (butuh >=200 latih dan >=100 uji), dilewati. Pastikan CSV punya kolom PSH/PSD/PSA atau B365H/D/A.');
  const fin = (r: Rec) => probs(r, final);

  // --- E. Aturan keputusan "Seri" dan kalibrasi keyakinan ---
  const decide = (r: Rec) => { const q = fin(r); return decide1x2(q[0], q[1], q[2]) === '1' ? 0 : decide1x2(q[0], q[1], q[2]) === 'X' ? 1 : 2; };
  console.log('\nE. Aturan pick 1X2 (set uji, model akhir):');
  console.log(`   argmax biasa: akurasi ${pct(mean(test.map(r => +(argmax(fin(r)) === r.out))))} | decide1x2 (aplikasi): ${pct(mean(test.map(r => +(decide(r) === r.out))))}, memilih Seri ${pct(mean(test.map(r => +(decide(r) === 1))))} dari laga (seri sebenarnya ${pct(mean(test.map(r => +(r.out === 1))))})`);
  console.log(`   selalu Kandang: ${pct(mean(test.map(r => +(r.out === 0))))}`);
  console.log('   Kalibrasi (peluang tertinggi vs kejadian sebenarnya):');
  const bins = [[0, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 1.01]];
  for (const [lo, hi] of bins) {
    const s = test.filter(r => { const q = Math.max(...fin(r)); return q >= lo && q < hi; });
    if (s.length) console.log(`     ${String(lo).padEnd(4)}-${String(Math.min(hi, 1)).padEnd(4)} n=${String(s.length).padEnd(5)} prediksi ${pct(mean(s.map(r => Math.max(...fin(r)))))}  nyata ${pct(mean(s.map(r => +(argmax(fin(r)) === r.out))))}`);
  }

  // --- F. Menurut jumlah laga yang sudah dimainkan (di mana Elo vs klasemen unggul) ---
  console.log('\nF. Log-loss menurut jumlah laga tim di musim itu (seluruh set dinilai):');
  console.log('   ' + 'laga'.padEnd(8) + 'n'.padEnd(7) + 'klasemen  Elo       gabungan  pasar');
  for (const [lo, hi] of [[0, 5], [5, 10], [10, 20], [20, 100]]) {
    const s = recs.filter(r => r.n >= lo && r.n < hi); if (s.length < 30) continue;
    const m2 = withMkt(s);
    console.log('   ' + `${lo}-${hi - 1}`.padEnd(8) + String(s.length).padEnd(7) + [f4(meanLL(s, r => probs(r, { ...tuned1, mode: 'std' }))), f4(meanLL(s, r => probs(r, { ...tuned1, mode: 'elo' }))), f4(meanLL(s, r => probs(r, tuned1))), m2.length >= 30 ? f4(meanLL(m2, r => r.mkt as T3)) : '   -  '].join('    '));
  }

  // --- G. Over/Under 2.5 dan BTTS (hanya laporan) ---
  const ou = (r: Rec) => matrixStats(matrixOf(r, final)).o25, bt = (r: Rec) => { const m = matrixOf(r, final); let y = 0; for (let i = 1; i <= MAXG; i++) for (let j = 1; j <= MAXG; j++) y += m[i][j]; return y; };
  const bll = (p: number, y: boolean) => -Math.log(clamp(y ? p : 1 - p, 1e-6, 1)), rate = (f: (r: Rec) => boolean) => mean(train.map(r => +f(r)));
  const rO = rate(r => r.hg + r.ag >= 3), rB = rate(r => r.hg > 0 && r.ag > 0);
  console.log('\nG. Over 2.5 dan BTTS (set uji, log-loss biner; acak = 0.6931):');
  console.log(`   Over 2.5: model ${f4(mean(test.map(r => bll(ou(r), r.hg + r.ag >= 3))))} | frekuensi liga ${f4(mean(test.map(r => bll(rO, r.hg + r.ag >= 3))))}${test.some(r => r.mktO25 !== undefined) ? ` | pasar ${f4(mean(test.filter(r => r.mktO25 !== undefined).map(r => bll(r.mktO25 as number, r.hg + r.ag >= 3))))}` : ''}`);
  console.log(`   BTTS    : model ${f4(mean(test.map(r => bll(bt(r), r.hg > 0 && r.ag > 0))))} | frekuensi liga ${f4(mean(test.map(r => bll(rB, r.hg > 0 && r.ag > 0))))}`);

  // --- Rekomendasi ---
  const gain = -dT.d, sig = Math.abs(dT.d) >= 1.96 * dT.se && dT.d < 0;
  console.log('\n=== REKOMENDASI (scripts/config.ts) ===');
  if (!sig) console.log(`Tuning belum memberi perbaikan yang nyata di set uji (selisih ${gain.toFixed(4)}). Biarkan parameter default, jangan mengubah karena "kelihatannya lebih baik".`);
  else console.log(`Tuning memperbaiki log-loss uji sebesar ${gain.toFixed(4)} (nyata secara statistik). Nilai yang disarankan:`);
  console.log(`  eloSlope: ${bestE.s},  eloShrinkK: ${bestE.k},  rho: ${bestS.rho},  drawBoost: ${bestS.draw},  tempoSpread: ${bestS.spread}` + (rep.market ? `,  marketWeight: ${rep.market.marketW}` : ''));
  console.log('Catatan: Elo di sini dihitung dari hasil liga yang sama (bukan ClubElo/eloratings.net), jadi eloSlope hanya pendekatan. Untuk tim nasional, backtest terpisah dengan data internasional.');
  rep.recommend = { eloSlope: bestE.s, eloShrinkK: bestE.k, rho: bestS.rho, drawBoost: bestS.draw, tempoSpread: bestS.spread, significant: sig, gain, ...(rep.market ?? {}) };
  return rep;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('backtest.ts')) {
  if (!fs.existsSync(DIR)) { console.error(`Folder ${DIR} tidak ada. Lihat docs/BACKTEST.md untuk cara mengunduh CSV football-data.co.uk.`); process.exit(1); }
  const files = fs.readdirSync(DIR).filter(f => /\.csv$/i.test(f)).sort();
  if (!files.length) { console.error(`Tidak ada file .csv di ${DIR}.`); process.exit(1); }
  const all: Match[] = []; for (const f of files) { const m = loadCsv(path.join(DIR, f)); console.log(`${f}: ${m.length} laga`); all.push(...m); }
  const rep = runBacktest(all);
  try { fs.mkdirSync(path.dirname(REPORT), { recursive: true }); fs.writeFileSync(REPORT, JSON.stringify(rep, null, 1)); console.log(`\nLaporan: ${REPORT}`); } catch { /* opsional */ }
}
