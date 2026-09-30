import fs from 'node:fs';
import path from 'node:path';
import { CFG } from './config.ts';
import { loadResults } from './results.ts';
import type { Calibration, HistRow, HitStat, MarketTotal, Prediction, Probs3 } from '../shared/types.ts';
import { pickOptions } from '../shared/picks.ts';

/** ===== Rekam jejak & kalibrasi otomatis =====
 * Menggabungkan public/data/history/*.json (prediksi) dengan skor 90 menit sebenarnya (data/results.json, cadangan: cache fixture),
 * lalu menghitung akurasi, Brier, log-loss, tabel kalibrasi, dan menuning DUA parameter secara data-driven:
 *  - tau  : ketajaman probabilitas (p^tau). Hanya berubah bila sampel >= calMinN, dan ditarik ke 1 (shrinkage) bila sampel masih sedikit.
 *  - marketW : bobot pasar vs model. Hanya berubah bila laga ber-odds >= calMinMarketN.
 * Hasil ditulis ke public/data/calibration.json (dibaca run.ts & ditampilkan di situs). */

export type Out = '1' | 'X' | '2';
export const outcome = (h: number, a: number): Out => (h > a ? '1' : h === a ? 'X' : '2');
const pOf = (p: Probs3, o: Out) => (o === '1' ? p.home : o === 'X' ? p.draw : p.away);
const norm = (x: number[]) => { const s = x.reduce((a, b) => a + b, 0); return x.map(v => v / s); };
const tempered = (p: Probs3, tau: number): Probs3 => { const [a, b, c] = norm([p.home, p.draw, p.away].map(v => Math.pow(Math.max(v, 1e-6), tau))); return { home: a, draw: b, away: c }; };
const blended = (m: Probs3, k: Probs3, w: number): Probs3 => {
  const [a, b, c] = norm([[m.home, k.home], [m.draw, k.draw], [m.away, k.away]].map(([x, y]) => Math.pow(Math.max(x, 1e-6), 1 - w) * Math.pow(Math.max(y, 1e-6), w)));
  return { home: a, draw: b, away: c };
};
const ll = (p: Probs3, o: Out) => -Math.log(Math.max(pOf(p, o), 1e-6));
const brier = (p: Probs3, o: Out) => (p.home - +(o === '1')) ** 2 + (p.draw - +(o === 'X')) ** 2 + (p.away - +(o === '2')) ** 2;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r4 = (x: number | null) => (x === null ? null : Math.round(x * 1e4) / 1e4);
const hit = (xs: boolean[]): HitStat => ({ n: xs.length, acc: xs.length ? r4(xs.filter(Boolean).length / xs.length) : null });

export interface Sample {
  id: number; ts: number; home: string; away: string; pick: Out; out: Out; goals: [number, number];
  probs: Probs3; raw: Probs3; model?: Probs3; market?: Probs3;
  league?: string; hdp?: { side: '1' | '2'; line: number };
  conf: number; level: 'high' | 'medium' | 'low'; pOver25: number; pBtts: number; aiAgree?: boolean; aiPick?: Out; aiBtts?: 'yes' | 'no'; aiOu?: 'over' | 'under'; aiHdp?: { side: '1' | '2'; line: number };
}

/** Cari nilai parameter yang meminimalkan rata-rata loss pada grid. */
function argmin(grid: number[], f: (x: number) => number): number { let bx = grid[0], bv = Infinity; for (const x of grid) { const v = f(x); if (v < bv) { bv = v; bx = x; } } return bx; }
const range = (a: number, b: number, s: number) => { const o: number[] = []; for (let x = a; x <= b + 1e-9; x += s) o.push(Math.round(x * 1e4) / 1e4); return o; };

/** Hasil handicap Asia untuk sisi terpilih: 1 menang (penuh/setengah), -1 kalah (penuh/setengah), 0 push. d = gol sisi itu - gol lawan. */
export function ahResult(d: number, line: number): 1 | 0 | -1 {
  const quarter = Math.abs(line * 4) % 2 === 1, comps = quarter ? [line - 0.25, line + 0.25] : [line];
  const m = comps.reduce((a, c) => a + (d + c > 1e-9 ? 1 : d + c < -1e-9 ? -1 : 0), 0) / comps.length;
  return m > 0 ? 1 : m < 0 ? -1 : 0;
}

/** ===== Riwayat & winrate gabungan =====
 * Pilihan per pasar sama dengan yang tampil di kartu: 1X2 = hasil peluang tertinggi, O/U 2.5 & BTTS = sisi >= 50%,
 * HDP = pick HDP tegas (HDP - unggulan / HDP + non-unggulan, mana yang lebih tegas; shared/picks.ts), ada bila peluangnya >= 60%.
 * HDP push (uang kembali) tidak dihitung menang/kalah, dan tidak menggagalkan gabungan. */
const ouHit = (s: Sample) => (s.pOver25 >= 0.5) === (s.goals[0] + s.goals[1] >= 3);
const bttsHit = (s: Sample) => (s.pBtts >= 0.5) === (s.goals[0] > 0 && s.goals[1] > 0);
const hdpRes = (s: Sample): 'win' | 'loss' | 'push' | null => {
  if (!s.hdp) return null;
  const r = ahResult(s.hdp.side === '1' ? s.goals[0] - s.goals[1] : s.goals[1] - s.goals[0], s.hdp.line);
  return r === 1 ? 'win' : r === -1 ? 'loss' : 'push';
};
const total = (xs: boolean[]): MarketTotal => { const h = xs.filter(Boolean).length; return { n: xs.length, hit: h, acc: xs.length ? r4(h / xs.length) : null }; };
const HIST_MAX = 3000;
export function summarize(samples: Sample[], now = new Date()): Calibration {
  const n = samples.length;
  const bins = [[0, 20], [20, 40], [40, 60], [60, 101]].map(([lo, hi]) => {
    const s = samples.filter(x => x.conf >= lo && x.conf < hi);
    return { label: hi > 100 ? `${lo}+` : `${lo}-${hi - 1}`, n: s.length, acc: hit(s.map(x => x.pick === x.out)).acc, meanConf: r4(mean(s.map(x => x.conf))) };
  });
  const lvl = (l: 'high' | 'medium' | 'low') => hit(samples.filter(x => x.level === l).map(x => x.pick === x.out));
  const withAi = samples.filter(x => x.aiAgree !== undefined), withAiPick = samples.filter(x => x.aiPick !== undefined);

  // --- ketajaman (tau) dari probabilitas mentah (sebelum temperatur) ---
  let tauRaw: number | null = null, tau = 1, note = `Menunggu ${CFG.calMinN} laga untuk menuning ketajaman (baru ${n}).`;
  if (n >= 30) tauRaw = argmin(range(0.6, 1.8, 0.05), t => mean(samples.map(s => ll(tempered(s.raw, t), s.out)))!);
  if (n >= CFG.calMinN && tauRaw !== null) {
    tau = Math.min(CFG.tauMax, Math.max(CFG.tauMin, 1 + (n / (n + CFG.calMinN)) * (tauRaw - 1)));
    note = `Ketajaman dituning dari ${n} laga (tau mentah ${tauRaw.toFixed(2)} -> dipakai ${tau.toFixed(2)}).`;
  }
  // --- bobot pasar dari laga yang punya model murni + pasar ---
  const mk = samples.filter(s => s.model && s.market);
  let bestW: number | null = null, marketW = CFG.marketWeight;
  const llAt = (w: number) => mean(mk.map(s => ll(blended(s.model!, s.market!, w), s.out)));
  if (mk.length >= 20) bestW = argmin(range(0, 1, 0.05), w => llAt(w)!);
  if (mk.length >= CFG.calMinMarketN && bestW !== null) {
    marketW = Math.min(CFG.marketWMax, Math.max(CFG.marketWMin, CFG.marketWeight + (mk.length / (mk.length + CFG.calMinMarketN)) * (bestW - CFG.marketWeight)));
    note += ` Bobot pasar dituning dari ${mk.length} laga ber-odds (terbaik ${bestW.toFixed(2)} -> dipakai ${marketW.toFixed(2)}).`;
  } else if (mk.length) note += ` Bobot pasar tetap ${CFG.marketWeight} (${mk.length}/${CFG.calMinMarketN} laga ber-odds).`;

  const recent = [...samples].sort((a, b) => b.ts - a.ts).slice(0, 24).map(s => ({ home: s.home, away: s.away, pick: s.pick, score: `${s.goals[0]}-${s.goals[1]}`, hit: s.pick === s.out }));
  const combo3 = (s: Sample) => s.pick === s.out && ouHit(s) && bttsHit(s);
  const combo4 = (s: Sample): boolean | null => { const r = hdpRes(s); return r === null || r === 'push' ? null : combo3(s) && r === 'win'; };
  const history: HistRow[] = [...samples].sort((a, b) => b.ts - a.ts).slice(0, HIST_MAX).map(s => {
    const r = hdpRes(s);
    return { id: s.id, ts: s.ts, league: s.league, home: s.home, away: s.away, score: `${s.goals[0]}-${s.goals[1]}`, conf: s.conf,
      x12: { pick: s.pick, hit: s.pick === s.out }, ou: { pick: s.pOver25 >= 0.5 ? 'over' : 'under', hit: ouHit(s) }, btts: { pick: s.pBtts >= 0.5 ? 'yes' : 'no', hit: bttsHit(s) },
      ...(s.hdp && r ? { hdp: { side: s.hdp.side, line: s.hdp.line, res: r } } : {}), combo3: combo3(s), combo4: combo4(s) };
  });
  const hdpDone = samples.map(hdpRes).filter((r): r is 'win' | 'loss' => r === 'win' || r === 'loss');
  const c4 = samples.map(combo4).filter((x): x is boolean => x !== null);
  const totals = {
    x12: total(samples.map(s => s.pick === s.out)), ou25: total(samples.map(ouHit)), btts: total(samples.map(bttsHit)),
    hdp: total(hdpDone.map(r => r === 'win')), hdpPush: samples.filter(s => hdpRes(s) === 'push').length,
    overall: total([...samples.map(s => s.pick === s.out), ...samples.map(ouHit), ...samples.map(bttsHit), ...hdpDone.map(r => r === 'win')]),
    combo3: total(samples.map(combo3)), combo4: total(c4),
  };
  return {
    version: 1, updatedAt: now.toISOString(), n,
    acc: hit(samples.map(s => s.pick === s.out)).acc, brier: r4(mean(samples.map(s => brier(s.probs, s.out)))), logloss: r4(mean(samples.map(s => ll(s.probs, s.out)))),
    uniform: { brier: 0.6667, logloss: 1.0986 },
    byLevel: { high: lvl('high'), medium: lvl('medium'), low: lvl('low') }, bins,
    ou25: hit(samples.map(s => (s.pOver25 >= 0.5) === (s.goals[0] + s.goals[1] >= 3))),
    btts: hit(samples.map(s => (s.pBtts >= 0.5) === (s.goals[0] > 0 && s.goals[1] > 0))),
    ai: { agree: hit(withAi.filter(s => s.aiAgree).map(s => s.pick === s.out)), disagree: hit(withAi.filter(s => !s.aiAgree).map(s => s.pick === s.out)), own: hit(withAiPick.map(s => s.aiPick === s.out)), formulaSame: hit(withAiPick.map(s => s.pick === s.out)),
      ou25: hit(samples.filter(s => s.aiOu).map(s => (s.aiOu === 'over') === (s.goals[0] + s.goals[1] >= 3))),
      btts: hit(samples.filter(s => s.aiBtts).map(s => (s.aiBtts === 'yes') === (s.goals[0] > 0 && s.goals[1] > 0))),
      hdp: hit(samples.filter(s => s.aiHdp).map(s => ahResult(s.aiHdp!.side === '1' ? s.goals[0] - s.goals[1] : s.goals[1] - s.goals[0], s.aiHdp!.line)).filter(r => r !== 0).map(r => r === 1)) },
    market: { n: mk.length, llModel: r4(llAt(0)), llMarket: r4(llAt(1)), llBlend: r4(llAt(marketW)), bestW: bestW === null ? null : r4(bestW) },
    tuning: { tauRaw: r4(tauRaw), tau: r4(tau)!, marketW: r4(marketW)!, note }, recent, totals, history,
  };
}

/** Skor 90 menit dari cache fixture (cadangan untuk laga yang selesai sebelum results.json menyimpan skor). */
function scoresFromCache(dir: string): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('fixtures_date_') || !f.endsWith('.json')) continue;
      try {
        for (const x of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).data ?? []) {
          if (!['FT', 'AET', 'PEN'].includes(x?.fixture?.status?.short)) continue;
          const h = x?.score?.fulltime?.home ?? x?.goals?.home, a = x?.score?.fulltime?.away ?? x?.goals?.away;
          if (typeof h === 'number' && typeof a === 'number') out.set(x.fixture.id, [h, a]);
        }
      } catch { /* lewati file rusak */ }
    }
  } catch { /* folder belum ada */ }
  return out;
}

/** Pick HDP tegas laga ini (HDP - / HDP +, mana lebih tegas). undefined bila data handicap tidak ada atau tidak ada garis >= 60%. */
function hdpPick(p: Prediction): { side: '1' | '2'; line: number } | undefined {
  try { const o = pickOptions(p).others.find(x => x.kind === 'hdpFav' || x.kind === 'hdpDog'); return o?.side && o.line !== undefined ? { side: o.side, line: o.line } : undefined; } catch { return undefined; }
}

/** Kumpulkan sampel: prediksi (history) yang hasilnya sudah diketahui. Bila satu laga ada di beberapa file, ambil yang terbaru. */
export function loadSamples(): Sample[] {
  const histDir = path.join(CFG.dataDir, 'history'), latest = new Map<number, { at: string; p: Prediction }>();
  try {
    for (const f of fs.readdirSync(histDir)) {
      if (!/^\d{4}-\d{2}-\d{2}(-malam)?\.json$/.test(f)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(histDir, f), 'utf8'));
        for (const p of (j.matches ?? []) as Prediction[]) { const c = latest.get(p.id); if (!c || String(j.generatedAt) >= c.at) latest.set(p.id, { at: String(j.generatedAt), p }); }
      } catch { /* lewati */ }
    }
  } catch { return []; }
  const res = loadResults(CFG.resultsFile), cache = scoresFromCache(CFG.cacheDir), out: Sample[] = [];
  for (const { p } of latest.values()) {
    const sc = res.scores?.[String(p.id)] ?? cache.get(p.id);
    if (!sc || !p.probs) continue;
    const pick = (p.picks?.pick1x2 ?? 'X') as Out, mk = p.market;
    out.push({
      id: p.id, ts: p.timestamp, league: p.league?.name, hdp: hdpPick(p), home: p.home.name, away: p.away.name, pick, out: outcome(sc[0], sc[1]), goals: sc,
      probs: p.probs, raw: p.rawProbs ?? p.probs, model: p.modelProbs, market: mk ? { home: mk.home, draw: mk.draw, away: mk.away } : undefined,
      conf: p.confidence, level: p.confidenceLevel, pOver25: p.ou?.[1]?.over ?? 0.5, pBtts: p.btts?.yes ?? 0.5,
      aiAgree: p.aiOpinion ? p.aiOpinion.agree : undefined, aiPick: p.aiOpinion?.pick, aiBtts: p.aiOpinion?.btts, aiOu: p.aiOpinion?.ou25, aiHdp: p.aiOpinion?.hdp,
    });
  }
  return out;
}

export function evaluate(): Calibration {
  const cal = summarize(loadSamples());
  fs.mkdirSync(path.dirname(CFG.calibrationFile), { recursive: true });
  const tmp = CFG.calibrationFile.replace('.json', '.tmp.json');
  fs.writeFileSync(tmp, JSON.stringify(cal)); JSON.parse(fs.readFileSync(tmp, 'utf8')); fs.renameSync(tmp, CFG.calibrationFile);
  console.log(`[evaluasi] ${cal.n} laga dinilai · akurasi ${cal.acc ?? '-'} · Brier ${cal.brier ?? '-'} (acak 0.667) · log-loss ${cal.logloss ?? '-'} (acak 1.099) · tau ${cal.tuning.tau} · bobot pasar ${cal.tuning.marketW}`);
  return cal;
}

/** Parameter kalibrasi yang dipakai run.ts. File belum ada / rusak -> nilai bawaan (tau 1, bobot pasar CFG.marketWeight). */
export function activeCalibration(file = CFG.calibrationFile): { tau: number; marketW: number; n: number } {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as Calibration, t = c?.tuning;
    if (t && Number.isFinite(t.tau) && Number.isFinite(t.marketW)) return { tau: t.tau, marketW: t.marketW, n: c.n ?? 0 };
  } catch { /* pakai bawaan */ }
  return { tau: 1, marketW: CFG.marketWeight, n: 0 };
}

if (process.argv[1]?.endsWith('evaluate.ts')) evaluate();