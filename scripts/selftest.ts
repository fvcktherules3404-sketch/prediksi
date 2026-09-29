import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CFG } from './config.ts';
import { scoreMatrix, ahLine, buildPrediction, leagueAverages } from './engine.ts';
import { computeWindow } from './run.ts';
import { matchTeams, type Row } from './standings.ts';
import { emptyResults, addFixture, ownRows, addDays } from './results.ts';
import { parseFdStandings } from './footballData.ts';
import { validateAiRow, extractJsonArray } from './geminiStandings.ts';

const m = scoreMatrix(1.6, 1.1);
assert(Math.abs(m.flat().reduce((a, b) => a + b, 0) - 1) < 1e-9, 'matriks harus berjumlah 1');
for (const l of [-1.75, -0.5, 0, 0.25, 1]) { const a = ahLine(m, l); assert(Math.abs(a.win + a.halfWin + a.push + a.halfLoss + a.loss - 1) < 2e-3, 'AH jumlah=1'); }
const a0 = ahLine(m, 0), a1 = ahLine(scoreMatrix(1.1, 1.6), 0);
assert(Math.abs(a0.win - a1.loss) < 2e-3, 'AH simetris');
const row = (gf: number, ga: number, p: number, rank: number, form: string) => ({ rank, form, all: { played: p * 2, goals: { for: gf * 2, against: ga * 2 } }, home: { played: p, goals: { for: gf, against: ga } }, away: { played: p, goals: { for: gf, against: ga } } });
const H = row(20, 8, 10, 1, 'WWWDW'), A = row(9, 18, 10, 18, 'LLDLL');
const lg = leagueAverages([H, A]);
const fx = { fixture: { id: 1, timestamp: 1e9 }, league: { id: 39, name: 'X', season: 2026 }, teams: { home: { id: 1, name: 'A' }, away: { id: 2, name: 'B' } } };
const p = buildPrediction(fx, H, A, lg);
assert(Math.abs(p.probs.home + p.probs.draw + p.probs.away - 1) < 5e-3);
assert(p.probs.home > p.probs.away && p.xg.home > p.xg.away, 'tim kuat harus unggul');
const w = computeWindow(Date.UTC(2026, 8, 28, 23, 40)); // 29 Sep 06:40 WIB
assert.equal(w.dateA, '2026-09-29');
const w2 = computeWindow(Date.UTC(2026, 8, 28, 20, 0)); // 29 Sep 03:00 WIB -> window masih 28 Sep 06:00
assert.equal(w2.dateA, '2026-09-28');
// --- pencocokan nama (ID API-Football != ID football-data.org) ---
const R = (id: number, name: string, names: string[] = []): Row => ({ team: { id, name }, names, all: { played: 1, goals: { for: 1, against: 1 } }, home: { played: 1, goals: { for: 1, against: 1 } }, away: { played: 0, goals: { for: 0, against: 0 } }, source: 'official' });
const fdRows = [R(1, 'AC Milan'), R(2, 'FC Internazionale Milano', ['Inter']), R(3, 'Manchester United FC', ['Man United']), R(4, 'Manchester City FC'), R(5, 'Bayer 04 Leverkusen'), R(6, '1. FC Köln')];
const mt = matchTeams([{ id: 10, name: 'AC Milan' }, { id: 11, name: 'Inter' }, { id: 12, name: 'Manchester United' }, { id: 13, name: 'Manchester City' }, { id: 14, name: 'Bayer Leverkusen' }, { id: 15, name: 'FC Koln' }, { id: 16, name: 'Tim Asing' }], fdRows);
assert.deepEqual([...mt].map(([k, r]) => [k, r.team.id]), [[10, 1], [11, 2], [12, 3], [13, 4], [14, 5], [15, 6]], 'Milan/Inter/Manchester tidak boleh tertukar');
// --- klasemen buatan sendiri dari hasil ---
const fxr = (id: number, h: number, a: number, hg: number, ag: number, st = 'FT') => ({ fixture: { id, status: { short: st } }, league: { id: 39, season: 2026 }, teams: { home: { id: h, name: 'H' + h }, away: { id: a, name: 'A' + a } }, goals: { home: hg, away: ag } });
const rs = emptyResults();
assert(addFixture(rs, fxr(1, 1, 2, 3, 0)) && addFixture(rs, fxr(2, 2, 1, 1, 1)));
assert(!addFixture(rs, fxr(1, 1, 2, 3, 0)), 'duplikat harus dilewati'); assert(!addFixture(rs, fxr(3, 1, 2, 0, 0, 'NS')), 'belum selesai dilewati');
const or = ownRows(rs.leagues['39:2026']), t1 = or.get(1)!, t2 = or.get(2)!;
assert.equal(t1.rank, 1); assert.equal(t1.all.played, 2); assert.equal(t1.all.goals.for, 4); assert.equal(t1.home.played, 1); assert.equal(t1.away.played, 1); assert.equal(t1.form, 'WD'); assert.equal(t2.form, 'LD');
assert.equal(addDays('2026-09-01', -1), '2026-08-31');
// --- parsing football-data.org ---
const fdj = { standings: [{ type: 'TOTAL', table: [{ position: 1, team: { id: 9, name: 'X FC', shortName: 'X', tla: 'XXX' }, playedGames: 6, form: 'W,W,D,L,W', goalsFor: 12, goalsAgainst: 4 }] }, { type: 'HOME', table: [{ team: { id: 9 }, playedGames: 3, goalsFor: 8, goalsAgainst: 1 }] }, { type: 'AWAY', table: [{ team: { id: 9 }, playedGames: 3, goalsFor: 4, goalsAgainst: 3 }] }] };
const pr = parseFdStandings(fdj)[0]; assert.equal(pr.form, 'WWDLW'); assert.equal(pr.home.goals.for, 8); assert.equal(pr.away.played, 3);
// --- validasi Gemini: data tak masuk akal harus ditolak ---
const ok = { rank: 3, form: 'wwdlw', home: { played: 3, gf: 6, ga: 2 }, away: { played: 3, gf: 4, ga: 3 } };
assert.equal(validateAiRow(ok)!.all.played, 6); assert.equal(validateAiRow(ok)!.form, 'WWDLW'); assert.equal(validateAiRow(ok)!.source, 'ai');
assert.equal(validateAiRow({ ...ok, home: { played: 3, gf: 60, ga: 2 } }), null, 'gol tak wajar'); assert.equal(validateAiRow({ ...ok, home: { played: 9, gf: 6, ga: 2 } }), null, 'kandang/tandang timpang');
assert.equal(validateAiRow({ ...ok, home: { played: '3', gf: 6, ga: 2 } }), null, 'bukan angka'); assert.equal(validateAiRow(ok, 9), null, 'lebih sedikit dari data sendiri = basi');
assert.equal(extractJsonArray('Berikut:\n```json\n[{"a":1}]\n```').length, 1);
// --- Elo ---
import { parseClubElo, parseNationalElo, matchElo } from './elo.ts';
import { eloExpectedGoals } from './engine.ts';
const ce = parseClubElo('Rank,Club,Country,Level,Elo,From,To\nNone,Man City,ENG,1,2050.5,2026-09-20,2026-09-27\nNone,Man United,ENG,1,1850,2026-09-20,2026-09-27\nNone,Bayern,GER,1,2000,2026-09-20,2026-09-27\nNone,Inter,ITA,1,1950,2026-09-20,2026-09-27\nNone,Leverkusen,GER,1,1900,x,y');
assert.equal(ce.length, 5); assert.equal(ce[0].elo, 2050.5);
const me = matchElo([{ id: 1, name: 'Manchester City' }, { id: 2, name: 'Manchester United' }, { id: 3, name: 'Bayern Munich' }, { id: 4, name: 'Bayer Leverkusen' }, { id: 5, name: 'Inter' }, { id: 6, name: 'France U21' }], ce);
assert.deepEqual([...me], [[1, 2050.5], [2, 1850], [3, 2000], [4, 1900], [5, 1950]], 'Elo: City/United tidak boleh tertukar, U21 diabaikan');
const ne = parseNationalElo('1\t0\tES\t2150\t1\n2\t0\tFR\t2100\t1', 'ES\tSpain\nFR\tFrance\nBR\tBrazil');
assert.deepEqual(ne, [{ name: 'Spain', elo: 2150 }, { name: 'France', elo: 2100 }]);
assert.equal(matchElo([{ id: 9, name: 'Spain' }, { id: 8, name: 'USA' }], [...ne, { name: 'United States', elo: 1800 }]).get(8), 1800, 'alias USA');
const eq = eloExpectedGoals({ home: 2000, away: 2000, neutral: true }, lg), ed = eloExpectedGoals({ home: 2200, away: 2000, neutral: true }, lg);
assert(Math.abs(eq.lh - eq.la) < 1e-9 && ed.lh > ed.la, 'Elo: setara -> seimbang, unggul -> xG lebih besar');
assert(ed.lh - ed.la > 0.5 && ed.lh - ed.la < 1.2, 'Elo: 200 poin ~ 0.8 gol');
const pe = buildPrediction(fx, null, null, lg, { home: 2150, away: 1800 }), pb = buildPrediction(fx, H, A, lg, { home: 1500, away: 2000 });
assert(pe.probs.home > 0.6 && pe.home.dataSource === 'elo' && pe.home.elo === 2150 && pe.confidence > 0, 'Elo-saja jalan');
assert(pb.xg.home < p.xg.home, 'Elo lawan menurunkan xG bila blend');
assert.throws(() => buildPrediction(fx, null, null, lg));
// --- seri & kalibrasi ---
import { decide1x2 } from './engine.ts';
assert.equal(decide1x2(0.36, 0.28, 0.36), 'X', 'laga seimbang -> Seri'); assert.equal(decide1x2(0.28, 0.28, 0.44), '2'); assert.equal(decide1x2(0.55, 0.25, 0.2), '1');
const bal = buildPrediction(fx, null, null, lg, { home: 1800, away: 1800, neutral: true }); assert.equal(bal.picks.pick1x2, 'X', 'Elo setara -> pick Seri');
const dm = scoreMatrix(1.3, 1.3); const dr = dm.reduce((a, r, i) => a + r[i], 0); assert(dr > 0.26 && dr < 0.36, 'peluang seri wajar: ' + dr);
// --- absen ---
import { absenceImpact } from './engine.ts'; import { validateAbsence, mergeAbsences } from './news.ts';
const ab = { home: [{ name: 'Star Striker', pos: 'FWD' as const, role: 'key' as const, status: 'out' as const }], away: [], source: 'ai' as const, checked: true };
const pa = buildPrediction(fx, H, A, lg, null, ab), p0 = buildPrediction(fx, H, A, lg, null);
assert(pa.xg.home < p0.xg.home && pa.absences!.adj.home < 0 && Math.abs(pa.xg.away - p0.xg.away) < 1e-9, 'striker kunci absen menurunkan xG sendiri saja');
const pk = buildPrediction(fx, H, A, lg, null, { home: [], away: [{ name: 'Top Keeper', pos: 'GK', role: 'key', status: 'out' }], source: 'ai', checked: true });
assert(pk.xg.home > p0.xg.home, 'kiper lawan absen menaikkan xG kita');
assert(absenceImpact(Array.from({ length: 20 }, () => ({ name: 'x', pos: 'FWD' as const, role: 'key' as const, status: 'out' as const }))).att <= 0.15, 'dibatasi 15%');
assert.equal(validateAbsence({ name: 'A' }), null); assert.equal(validateAbsence({ name: 'John Doe', pos: 'XYZ', role: 'god' })!.role, 'rotation');
assert.equal(mergeAbsences([{ name: 'J. Doe', pos: '?', role: 'unknown', status: 'out' }], [{ name: 'John Doe', pos: 'FWD', role: 'key', status: 'out' }]).length, 1, 'nama sama tidak dobel');
console.log('OK', JSON.stringify({ xg: p.xg, probs: p.probs, fair: p.fairHandicap, conf: p.confidence, pick: p.picks }));

// --- opini kedua AI ---
import { validateOpinion, applyOpinion, modelPick } from './gemini.ts';
assert.deepEqual(validateOpinion({ pick: 'x', score: '1-1', reason: ' seimbang ' }), { pick: 'X', score: '1-1', reason: 'seimbang' });
assert.equal(validateOpinion({ pick: '1', score: '0-2', reason: 'a' })!.score, null, 'skor bertentangan dengan pick dibuang');
assert.equal(validateOpinion({ pick: '3', reason: 'a' }), null); assert.equal(validateOpinion({ pick: '1', reason: '' }), null);
{ const q: any = JSON.parse(JSON.stringify(pe)), c0 = q.confidence, pk = modelPick(q);
  assert.equal(applyOpinion(q, { pick: pk, score: null, reason: 'r' }), true); assert.equal(q.confidence, Math.min(100, c0 + CFG.aiAgreeBonus));
  const q2: any = JSON.parse(JSON.stringify(pe)); assert.equal(applyOpinion(q2, { pick: pk === '2' ? '1' : '2', score: null, reason: 'r' }), false); assert.equal(q2.confidence, Math.max(0, c0 - CFG.aiDisagreePenalty)); assert.equal(q2.aiOpinion.agree, false); }
console.log('opini AI OK');

// ================= v2: pasar, kalibrasi, keyakinan, evaluasi =================
import { devig, parseMarket } from './odds.ts';
import { fitLambdas, matrixStats, geoBlend, temper } from './engine.ts';
import { summarize, outcome, type Sample } from './evaluate.ts';
import { pruneCache } from './cache.ts';

// de-vig: jumlah 1, urutan terjaga, odds tak valid ditolak
{ const p = devig([1.8, 3.6, 4.5])!; assert(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-9 && p[0] > p[1] && p[1] > p[2], 'devig');
  assert.equal(devig([1.0, 3, 4]), null); assert.equal(devig([1.2, 1.2, 1.2]), null, 'overround tak wajar'); assert.equal(devig([NaN, 3, 4]), null);
  const fav = devig([1.25, 6.5, 13])!; assert(fav[2] < 1 / 13, 'power devig: longshot tidak dilebih-lebihkan dibanding proporsional'); }
// parseMarket: rata-rata bandar, pencilan dibuang, Over 2.5 ikut
{ const bk = (name: string, h: number, d: number, a: number, ov = 1.9, un = 1.9) => ({ name, bets: [{ id: 1, name: 'Match Winner', values: [{ value: 'Home', odd: String(h) }, { value: 'Draw', odd: String(d) }, { value: 'Away', odd: String(a) }] }, { id: 5, name: 'Goals Over/Under', values: [{ value: 'Over 2.5', odd: String(ov) }, { value: 'Under 2.5', odd: String(un) }] }] });
  const mk = parseMarket([{ bookmakers: [bk('Pinnacle', 1.9, 3.6, 4.2), bk('Bet365', 1.88, 3.5, 4.3), bk('Unibet', 1.92, 3.6, 4.1), bk('Salah', 4.0, 3.0, 1.8)] }])!;
  assert.equal(mk.books, 3, 'pencilan dibuang'); assert(Math.abs(mk.home + mk.draw + mk.away - 1) < 5e-3 && mk.home > 0.45 && mk.over25! > 0.4 && mk.over25! < 0.6);
  assert.equal(parseMarket([]), null); assert.equal(parseMarket([{ bookmakers: [{ name: 'x', bets: [] }] }]), null); }
// fitLambdas memulihkan lambda asal dari 1X2 (+ Over 2.5) yang dihasilkan
{ const st = matrixStats(scoreMatrix(1.9, 0.9)), f = fitLambdas(1.4, 1.4, { p: [st.ph, st.pd, st.pa], o25: st.o25 });
  assert(Math.abs(f.lh - 1.9) < 0.08 && Math.abs(f.la - 0.9) < 0.08, `fit lambda: ${f.lh} ${f.la}`); }
// geoBlend / temper
{ const b0 = geoBlend([0.5, 0.3, 0.2], [0.2, 0.3, 0.5], 0), b1 = geoBlend([0.5, 0.3, 0.2], [0.2, 0.3, 0.5], 1); assert(Math.abs(b0[0] - 0.5) < 1e-9 && Math.abs(b1[0] - 0.2) < 1e-9);
  const t = temper([0.5, 0.3, 0.2], 1.2); assert(t[0] > 0.5 && t[2] < 0.2 && Math.abs(t[0] + t[1] + t[2] - 1) < 1e-9); }
// buildPrediction dengan pasar
{ const base = buildPrediction(fx, H, A, lg, { home: 1800, away: 1800 }), mkA = { home: 0.2, draw: 0.27, away: 0.53, over25: 0.6, books: 5 }, mkH = { home: base.probs.home, draw: base.probs.draw, away: base.probs.away, books: 5 };
  const withA = buildPrediction(fx, H, A, lg, { home: 1800, away: 1800 }, null, { market: mkA, marketW: 0.6 }), withSame = buildPrediction(fx, H, A, lg, { home: 1800, away: 1800 }, null, { market: mkH, marketW: 0.6 });
  assert(withA.probs.away > base.probs.away && withA.probs.home < base.probs.home, 'pasar menggeser peluang');
  assert(Math.abs(withA.probs.home + withA.probs.draw + withA.probs.away - 1) < 5e-3);
  assert(withA.market && withA.modelProbs && withA.rawProbs && withA.calib!.marketW > 0, 'metadata untuk evaluasi tersimpan');
  assert(Math.abs(withSame.probs.home - base.probs.home) < 0.02, 'pasar = model -> tidak berubah');
  assert(withSame.conf!.agreement > withA.conf!.agreement, 'model-pasar sepakat -> agreement lebih tinggi');
  assert(withSame.confidence >= base.confidence, 'pasar yang sepakat menaikkan keyakinan (kualitas data naik)');
  const noOdds = buildPrediction(fx, H, A, lg, { home: 1800, away: 1800 }, null, { market: null }); assert.equal(noOdds.confidence, base.confidence);
  // temperatur > 1 lebih tajam
  const sharp = buildPrediction(fx, null, null, lg, { home: 2150, away: 1800 }, null, { tau: 1.2 }), flat = buildPrediction(fx, null, null, lg, { home: 2150, away: 1800 });
  assert(Math.max(sharp.probs.home, sharp.probs.away) > Math.max(flat.probs.home, flat.probs.away), 'tau>1 lebih tajam');
  // laga persahabatan: keyakinan dipotong
  const fr = buildPrediction({ ...fx, league: { ...fx.league, id: 10 } }, null, null, lg, { home: 2150, away: 1800 }), nf = buildPrediction({ ...fx, league: { ...fx.league, id: 5 } }, null, null, lg, { home: 2150, away: 1800 });
  assert(fr.confidence < nf.confidence && fr.conf!.comp === CFG.friendlyConfFactor, 'friendly menurunkan keyakinan');
  // Elo + sedikit klasemen tidak lagi dihukum dibanding Elo-saja (bug lama: 0.4 vs 0.595)
  const eo = buildPrediction(fx, null, null, lg, { home: 2000, away: 1900 }), ew = buildPrediction(fx, { ...H, all: { played: 1, goals: { for: 2, against: 1 } }, home: { played: 0, goals: { for: 0, against: 0 } } }, { ...A, all: { played: 1, goals: { for: 1, against: 2 } }, away: { played: 0, goals: { for: 0, against: 0 } } }, lg, { home: 2000, away: 1900 });
  assert(ew.conf!.quality >= eo.conf!.quality, 'Elo+1 laga >= Elo-saja'); }
// evaluasi: metrik, tuning tau, bobot pasar
{ let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const mkS = (i: number, model: [number, number, number], market: [number, number, number], truth: [number, number, number]): Sample => {
    const r = rnd(), o = r < truth[0] ? '1' : r < truth[0] + truth[1] ? 'X' : '2';
    const P = (a: number[]) => ({ home: a[0], draw: a[1], away: a[2] });
    return { id: i, ts: i, home: 'H', away: 'A', pick: model[0] >= model[2] ? '1' : '2', out: o, goals: o === '1' ? [1, 0] : o === 'X' ? [0, 0] : [0, 1], probs: P(model), raw: P(model), model: P(model), market: P(market), conf: 30, level: 'medium', pOver25: 0.5, pBtts: 0.5 } as Sample; };
  // model terlalu landai (0.42/0.30/0.28) padahal kenyataannya jauh lebih tegas (0.60/0.25/0.15); pasar akurat
  const S: Sample[] = Array.from({ length: 400 }, (_, i) => mkS(i, [0.42, 0.30, 0.28], [0.60, 0.25, 0.15], [0.60, 0.25, 0.15]));
  const c = summarize(S); assert.equal(c.n, 400);
  assert(c.tuning.tauRaw! > 1.2 && c.tuning.tau > 1.0 && c.tuning.tau <= CFG.tauMax, `tau harus naik: ${JSON.stringify(c.tuning)}`);
  assert(c.market.bestW! >= 0.8 && c.tuning.marketW > CFG.marketWeight, 'pasar lebih baik -> bobot pasar naik: ' + JSON.stringify(c.market));
  assert(c.market.llMarket! < c.market.llModel!, 'log-loss pasar < model');
  const small = summarize(S.slice(0, 40)); assert.equal(small.tuning.tau, 1, 'sampel sedikit -> tau tetap 1'); assert.equal(small.tuning.marketW, CFG.marketWeight);
  assert(c.acc! > 0.5 && c.byLevel.medium.n === 400 && c.bins.reduce((a, b) => a + b.n, 0) === 400); }
assert.equal(outcome(2, 1), '1'); assert.equal(outcome(1, 1), 'X'); assert.equal(outcome(0, 3), '2');
// skor 90 menit disimpan (bukan skor perpanjangan)
{ const rs2 = emptyResults(); addFixture(rs2, { ...fxr(90, 1, 2, 2, 1, 'AET'), score: { fulltime: { home: 1, away: 1 } } }); assert.deepEqual(rs2.scores!['90'], [1, 1], 'skor 90 menit'); addFixture(rs2, fxr(91, 1, 2, 0, 2)); assert.deepEqual(rs2.scores!['91'], [0, 2]); }
// pruneCache: hanya hapus yang berumur (ts) > batas; file tanpa ts dibiarkan
{ const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-')); fs.writeFileSync(path.join(d, 'old.json'), JSON.stringify({ ts: Date.now() - 10 * 864e5, data: 1 })); fs.writeFileSync(path.join(d, 'new.json'), JSON.stringify({ ts: Date.now(), data: 1 })); fs.writeFileSync(path.join(d, 'usage.json'), JSON.stringify({ date: 'x', used: 1 }));
  assert.equal(pruneCache(d, 4), 1); assert.deepEqual(fs.readdirSync(d).sort(), ['new.json', 'usage.json']); fs.rmSync(d, { recursive: true }); }
console.log('v2 OK (pasar, kalibrasi, keyakinan, evaluasi)');
