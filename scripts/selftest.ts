import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CFG } from './config.ts';
import { readTavilyKeys, webSearch, tavilySummary } from './search.ts';
import { scoreMatrix, ahLine, buildPrediction, leagueAverages } from './engine.ts';
import { computeWindow } from './run.ts';
import { matchTeams, type Row } from './standings.ts';
import { emptyResults, addFixture, ownRows, addDays, collectResults } from './results.ts';
import { parseFdStandings } from './footballData.ts';
import { pickHeadline } from './headline.ts';
import { isSeniorMen } from './filter.ts';
import { marketElo } from './engine.ts';
import { validateAiRow, extractJsonArray } from './geminiStandings.ts';
import { ApiUsage, keyId } from './apiUsage.ts';
import { FootballApi, readApiKeys } from './footballApi.ts';

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
// --- v4: dua sesi (pagi 06:00-20:59, malam 21:00-05:59 WIB) ---
{
  const a = computeWindow(Date.UTC(2026, 8, 28, 23, 40)); // 29 Sep 06:40 WIB
  assert.equal(a.slot, 'pagi'); assert.equal(a.start, Date.UTC(2026, 8, 28, 23, 0)); assert.equal(a.end, Date.UTC(2026, 8, 29, 14, 0) - 1000);
  const b = computeWindow(Date.UTC(2026, 8, 29, 14, 30)); // 29 Sep 21:30 WIB
  assert.equal(b.slot, 'malam'); assert.equal(b.start, Date.UTC(2026, 8, 29, 14, 0)); assert.equal(b.end, Date.UTC(2026, 8, 29, 23, 0) - 1000); assert.equal(b.dayStart, a.start); assert.equal(b.dateA, '2026-09-29');
  const c = computeWindow(Date.UTC(2026, 8, 29, 20, 0)); // 30 Sep 03:00 WIB: masih sesi malam 29 Sep
  assert.equal(c.slot, 'malam'); assert.equal(c.start, b.start); assert.equal(c.dateDay, '2026-09-29');
  assert.equal(a.endAll, b.end, 'pagi membuat pratinjau sampai akhir sesi malam');
  assert.equal(a.end + 1000, b.start, 'sesi bersambung tanpa celah'); assert.equal(b.end + 1000, computeWindow(Date.UTC(2026, 8, 29, 23, 5)).start);
}
// --- v4: prediksi utama ---
{
  const base = { home: { name: 'Alpha' }, away: { name: 'Beta' }, picks: {} } as any;
  const ahs = (rows: [number, number, number, number, number][]) => rows.map(([line, win, halfWin, push, loss]) => ({ line, win, halfWin, push, halfLoss: 0, loss }));
  const mk = (probs: any, over: number, btts: number, hs: any[] = []) => ({ ...base, probs, ou: [{}, { line: 2.5, over, under: 1 - over }, {}], btts: { yes: btts, no: 1 - btts }, handicap: hs });
  let hl = pickHeadline(mk({ home: 0.5, draw: 0.28, away: 0.22 }, 0.5, 0.5));
  assert.equal(hl.market, '1x2'); assert.equal(hl.label, 'Alpha');
  hl = pickHeadline(mk({ home: 0.36, draw: 0.32, away: 0.32 }, 0.78, 0.5)); assert.equal(hl.market, 'ou'); assert.equal(hl.label, 'Over 2.5');
  hl = pickHeadline(mk({ home: 0.34, draw: 0.33, away: 0.33 }, 0.5, 0.2)); assert.equal(hl.market, 'btts'); assert.equal(hl.label, 'BTTS Tidak');
  hl = pickHeadline(mk({ home: 0.33, draw: 0.3, away: 0.37 }, 0.5, 0.5)); assert.equal(hl.market, '1x2'); assert.equal(hl.label, 'Beta');
  hl = pickHeadline(mk({ home: 0.34, draw: 0.3, away: 0.36 }, 0.5, 0.5, ahs([[-1, 0.2, 0, 0.1, 0.7], [0.5, 0.7, 0, 0, 0.3]])));
  assert.equal(hl.market, '1x2', 'HDP away hanya bila garisnya lolos'); // away favorit: sisi away pada garis -0.5 (home +0.5): loss 0.3 -> eff 0.3 < 0.6
  hl = pickHeadline(mk({ home: 0.55, draw: 0.25, away: 0.2 }, 0.5, 0.5, ahs([[-1.5, 0.15, 0, 0, 0.85], [-1, 0.42, 0, 0.16, 0.42], [-0.5, 0.55, 0, 0, 0.45], [0.5, 0.8, 0, 0, 0.2]])));
  assert.notEqual(hl.market, 'btts'); assert.ok(hl.strength > 0);
  hl = pickHeadline(mk({ home: 0.45, draw: 0.25, away: 0.3 }, 0.5, 0.5, ahs([[-0.5, 0.62, 0, 0, 0.38]]))); assert.equal(hl.market, 'hdp'); assert.equal(hl.label, 'Alpha -0.5');
}
// --- v4.1: filter putra senior & Elo semu dari pasar ---
{
  const F = (h: string, a: string, l = 'Liga') => ({ teams: { home: { name: h }, away: { name: a } }, league: { name: l } });
  assert.equal(isSeniorMen(F('Ghana', 'Gambia', 'Africa Cup of Nations - Qualification')), true);
  assert.equal(isSeniorMen(F('Ghana U20', 'Gambia U20')), false); assert.equal(isSeniorMen(F('Arsenal W', 'Chelsea W')), false);
  assert.equal(isSeniorMen(F('Barcelona', 'Real Madrid', 'La Liga Women')), false); assert.equal(isSeniorMen(F('Bayern München II', 'Ulm')), false);
  assert.equal(isSeniorMen(F('Al Ahly', 'Zamalek', 'Premier League')), true); assert.equal(isSeniorMen(F('Union Saint-Gilloise', 'Utrecht')), true);
  const lgA = { home: 1.45, away: 1.15 };
  for (const mk of [{ home: 0.5, draw: 0.27, away: 0.23 }, { home: 0.2, draw: 0.28, away: 0.52 }, { home: 0.36, draw: 0.3, away: 0.34 }]) {
    const e = marketElo(mk, lgA), x = eloExpectedGoals(e, lgA), st = matrixStats(scoreMatrix(x.lh, x.la));
    assert(Math.abs((st.ph - st.pa) - (mk.home - mk.away)) < 0.01, 'Elo semu harus mereproduksi selisih peluang pasar'); assert.equal(e.fromMarket, true);
  }
  const fxm = { fixture: { id: 7, timestamp: 1e9 }, league: { id: 999, name: 'X', season: 2026 }, teams: { home: { id: 1, name: 'A' }, away: { id: 2, name: 'B' } } };
  const mkt = { home: 0.55, draw: 0.25, away: 0.2, books: 3 }, pm = buildPrediction(fxm, null, null, lgA, marketElo(mkt, lgA), null, { market: mkt, marketW: 0.8 });
  assert.equal(pm.home.dataSource, 'market'); assert(Math.abs(pm.probs.home - 0.55) < 0.03, 'prediksi odds-saja mengikuti pasar');
  const pe = buildPrediction(fxm, null, null, lgA, { home: 1600, away: 1500 }, null, { market: mkt, marketW: 0.8 }); assert(pm.confidence <= pe.confidence, 'odds-saja tidak boleh lebih yakin dari Elo asli');
}
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
assert.equal(decide1x2(0.36, 0.28, 0.36), 'X', 'laga kembar & seri >= 28% -> Seri'); assert.equal(decide1x2(0.37, 0.26, 0.37), '1', 'kembar tapi seri < 28% -> tetap pilih tim'); assert.equal(decide1x2(0.40, 0.29, 0.31), '1', 'selisih >= 3 poin -> pilih tim'); assert.equal(decide1x2(0.30, 0.40, 0.30), 'X'); assert.equal(decide1x2(0.28, 0.28, 0.44), '2'); assert.equal(decide1x2(0.55, 0.25, 0.2), '1');
const bal = buildPrediction(fx, null, null, lg, { home: 1800, away: 1800, neutral: true }); assert.ok(Math.abs(bal.probs.home - bal.probs.away) < 1e-6, 'Elo setara & netral -> peluang kandang = tandang'); assert.ok(bal.probs.draw > 0.2 && bal.probs.draw < 0.35, 'peluang seri tetap ditampilkan'); assert.equal(bal.picks.pick1x2, (bal.probs.draw > bal.probs.home || bal.probs.draw >= 0.28) ? 'X' : '1', 'Elo setara: Seri hanya bila seri >= 28% atau tertinggi');
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
{ const v = validateOpinion({ pick: '1', score: '2-1', reason: 'a', btts: 'yes', ou25: 'over', hdp: { side: '1', line: -0.75 } })!;
  assert.equal(v.score, '2-1'); assert.equal(v.btts, 'yes'); assert.equal(v.ou25, 'over'); assert.deepEqual(v.hdp, { side: '1', line: -0.75 });
  assert.equal(validateOpinion({ pick: '1', score: '1-0', reason: 'a', btts: 'yes' })!.score, null, 'skor bertentangan dengan BTTS dibuang');
  assert.equal(validateOpinion({ pick: '1', score: '3-0', reason: 'a', ou25: 'under' })!.score, null, 'skor bertentangan dengan Over/Under dibuang');
  assert.equal(validateOpinion({ pick: '1', reason: 'a', hdp: { side: '1', line: -0.6 } })!.hdp, undefined, 'garis bukan kelipatan 0,25 dibuang');
  assert.equal(validateOpinion({ pick: '1', reason: 'a', hdp: { side: '3', line: 0 } })!.hdp, undefined); }
import { ahResult } from './evaluate.ts';
assert.equal(ahResult(1, -0.5), 1); assert.equal(ahResult(0, -0.5), -1); assert.equal(ahResult(1, -1), 0); assert.equal(ahResult(1, -0.75), 1, 'AH -0.75 menang 1 gol = menang setengah');
assert.equal(ahResult(0, -0.25), -1, 'AH -0.25 seri = kalah setengah'); assert.equal(ahResult(0, 0.25), 1, 'AH +0.25 seri = menang setengah'); assert.equal(ahResult(2, -1.5), 1); assert.equal(ahResult(-1, 0), -1);
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
// collectResults: hari terakhir selalu diambil ulang walau lastDate sudah di kemarin (laga yang tadinya belum selesai kini masuk)
{
  const rs3 = emptyResults(); rs3.lastDate = '2026-09-28';
  const asked: string[] = [];
  const fakeApi: any = { get: async (_e: string, q: any) => { asked.push(q.date); return { data: [{ ...fxr(501, 1, 2, 2, 0), league: { id: 39, season: 2026 }, fixture: { id: 501, timestamp: 1, status: { short: 'FT' } } }], source: 'live' }; } };
  const col = await collectResults(fakeApi, rs3, '2026-09-29');
  assert.deepEqual(asked, ['2026-09-28'], 'kemarin diambil ulang'); assert.equal(col.added, 1, 'laga baru terkumpul');
  const col2 = await collectResults(fakeApi, rs3, '2026-09-29'); assert.equal(col2.added, 0, 'ambil ulang tidak menggandakan');
}
console.log('collectResults ambil-ulang OK');
// --- v3: taruhan laga (situasi tabel) ---
import { tableCtx, situation, stakeMultipliers, seasonPhase } from './stakes.ts';
import { buildTable } from './run.ts';
{
  // Liga 20 tim, 38 laga. Setelah 30 laga: juara 70, 2nd 66, 4th 55, 5th 52, degradasi (rank 18) 30, aman (rank 17) 34.
  const pts = [70, 66, 60, 55, 52, 49, 47, 45, 44, 42, 41, 40, 39, 38, 37, 36, 34, 30, 28, 20];
  const all = pts.map(p => ({ pts: p, p: 30 }));
  const c = tableCtx(all, { pts: 55, p: 30 }, { pts: 41, p: 30 }, 20, 38);
  assert.equal(c.rankH, 4); assert.equal(c.rankA, 11); assert.equal(c.c4, 55); assert.equal(c.c5, 52); assert.equal(c.safe, 34); assert.equal(c.drop, 30);
  assert(Math.abs(seasonPhase(c) - 30 / 38) < 1e-9);
  const sH = situation(c, 'home'), sA = situation(c, 'away');
  assert.equal(sH.kind, 'europe'); assert(sH.defending, 'peringkat 4 menjaga posisi'); assert(sH.need > 0.5);
  assert.equal(sA.kind, 'safe', 'peringkat 11 dengan 8 laga tersisa: jauh dari semua garis'); assert(sA.need < 0.35); assert.equal(sA.label, 'Aman / tanpa target');
  // Tim degradasi 1 poin di bawah garis aman butuh poin; tim yang jauh di atas zona degradasi tidak
  const c2 = tableCtx(all, { pts: 30, p: 30 }, { pts: 47, p: 30 }, 20, 38);
  assert.equal(situation(c2, 'home').kind, 'relegation'); assert(!situation(c2, 'home').defending, 'zona degradasi = mengejar');
  // Efek RELATIF menjaga total gol: kandang berebut (need tinggi), tandang aman -> kandang naik, tandang turun, produk ~ 1 dan total ~ tetap
  const par = { rel: 0.2, level: 0, phase: 0, need0: 0.741 };
  const m = stakeMultipliers(c2, par);
  assert(m.home > 1 && m.away < 1, 'tim berebut naik, tim aman turun');
  assert(Math.abs(m.home * m.away - 1) < 1e-9, 'level 0 & phase 0 => log-pengali berlawanan tanda');
  // Semua parameter 0 => tidak ada efek; fase tidak diam-diam menurunkan gol
  const z = stakeMultipliers(c2, { rel: 0, level: 0, phase: 0, need0: 0.741 });
  assert.equal(z.home, 1); assert.equal(z.away, 1);
  // Simetri kandang/tandang
  const cs = tableCtx(all, { pts: 47, p: 30 }, { pts: 30, p: 30 }, 20, 38), ms = stakeMultipliers(cs, par);
  assert(Math.abs(ms.home - m.away) < 1e-12 && Math.abs(ms.away - m.home) < 1e-12);
}
{
  // buildTable: syarat kelayakan
  const mk = (id: number, pts: number, played: number, source: 'official' | 'own' | 'ai' = 'official'): Row => ({ team: { id, name: 'T' + id }, points: pts, rank: id, all: { played, goals: { for: 1, against: 1 } }, home: { played: 1, goals: { for: 1, against: 1 } }, away: { played: 1, goals: { for: 1, against: 1 } }, source });
  const rows = Array.from({ length: 20 }, (_, i) => mk(i + 1, 60 - i * 2, 30));
  const pool = { official: rows, own: [] as Row[] };
  assert(buildTable(39, pool, rows[3], rows[10]) !== null, 'liga domestik layak');
  assert.equal(buildTable(2, pool, rows[3], rows[10]), null, 'Liga Champions bukan kandang-tandang penuh');
  assert.equal(buildTable(39, pool, mk(1, 50, 30, 'ai'), mk(2, 40, 30, 'ai')), null, 'data AI tidak dipakai');
  const early = Array.from({ length: 20 }, (_, i) => mk(i + 1, 10 - (i >> 1), 6));
  assert.equal(buildTable(39, { official: early, own: [] }, early[1], early[8]), null, 'musim < 25% belum bermakna');
  assert.equal(buildTable(39, { official: rows.map(r => ({ ...r, points: undefined })), own: [] }, rows[3], rows[10]), null, 'tanpa poin => tanpa konteks');
}
{
  // buildPrediction membawa label & penyesuaian; CFG.stakesOn=false => label tetap, xG tidak berubah
  const pts = [70, 66, 60, 55, 52, 49, 47, 45, 44, 42, 41, 40, 39, 38, 37, 36, 34, 30, 28, 20];
  const table = tableCtx(pts.map(p => ({ pts: p, p: 30 })), { pts: 30, p: 30 }, { pts: 41, p: 30 }, 20, 38);
  const row = (rank: number) => ({ rank, form: 'WDLWD', all: { played: 30, goals: { for: 45, against: 40 } }, home: { played: 15, goals: { for: 24, against: 19 } }, away: { played: 15, goals: { for: 21, against: 21 } } });
  const fx2 = { fixture: { id: 2, timestamp: 1e9 }, league: { id: 39, name: 'X', season: 2026 }, teams: { home: { id: 1, name: 'A' }, away: { id: 2, name: 'B' } } };
  const lg2 = leagueAverages([row(1), row(2)]);
  const off = CFG.stakesOn;
  CFG.stakesOn = true; const pOn = buildPrediction(fx2, row(18), row(9), lg2, null, null, { table });
  CFG.stakesOn = false; const pOff = buildPrediction(fx2, row(18), row(9), lg2, null, null, { table });
  const pNone = buildPrediction(fx2, row(18), row(9), lg2);
  CFG.stakesOn = off;
  assert(pOn.stakes && pOn.stakes.home.kind === 'relegation' && pOn.stakes.away.kind === 'safe', 'label situasi');
  assert(pOn.xg.home > pNone.xg.home && pOn.xg.away < pNone.xg.away, 'tim degradasi naik, tim aman turun');
  assert(Math.abs((pOn.xg.home + pOn.xg.away) - (pNone.xg.home + pNone.xg.away)) < 0.05, 'total gol dijaga (Over/Under tidak digeser)');
  assert(pOff.stakes && pOff.stakes.adj.home === 0 && pOff.xg.home === pNone.xg.home, 'dimatikan: label saja');
  assert.equal(pNone.stakes, undefined, 'tanpa tabel => tanpa field stakes');
}
console.log('stakes OK');

// --- v5: konteks laga (final, derbi, leg 2, kelelahan, grup timnas, juara/degradasi pasti) ---
import { isFinalRound, isDerby, fatigueScore, restInfo, fatigueMultipliers, aggregateBeforeLeg2, leg2Multipliers, parseGroups, groupState, buildContext, isKnockoutRound, legKey } from './context.ts';
{
  assert(isFinalRound('Final') && !isFinalRound('Semi-finals') && !isFinalRound('Quarter-finals') && !isFinalRound('3rd Place Final') && !isFinalRound('Regular Season - 3'));
  assert(isDerby('Inter', 'AC Milan') && isDerby('Manchester City', 'Manchester United') && isDerby('Persib Bandung', 'Persija Jakarta') && isDerby('Real Madrid', 'Barcelona'));
  assert(!isDerby('Inter Miami', 'AC Milan') && !isDerby('Manchester City', 'Chelsea') && !isDerby('Arsenal', 'Arsenal'), 'derbi harus cocok persis');
  // kelelahan
  assert.equal(fatigueScore(null), null); assert.equal(fatigueScore(7), 0); assert.equal(fatigueScore(2), 1); assert(fatigueScore(3.5)! > 0.3 && fatigueScore(3.5)! < 0.5); assert.equal(fatigueScore(5, 3), 0.25);
  const ts = 1e9, r = restInfo([ts - 3 * 86400, ts - 8 * 86400, ts + 100], ts); assert(Math.abs(r.rest! - 3) < 1e-9 && r.n10 === 2, 'laga masa depan diabaikan');
  assert.equal(restInfo([], ts).rest, null);
  const [fh, fa] = fatigueMultipliers(1, 0, 0.03); assert(fh < 1 && fa > 1 && Math.abs(fh * fa - 1) < 1e-12); assert.deepEqual(fatigueMultipliers(1, null, 0.03), [1, 1]); assert.deepEqual(fatigueMultipliers(1, 0, 0), [1, 1]);
  // leg 2: leg 1 = A(kandang) 3-1 B  -> di leg 2 (B kandang) B tertinggal 2 => agregat untuk B = -2
  const leg1 = { h: 10, a: 20, hg: 3, ag: 1, ts: ts - 7 * 86400 };
  assert.equal(aggregateBeforeLeg2(leg1, 20, 10, ts), -2); assert.equal(aggregateBeforeLeg2(leg1, 10, 20, ts), null, 'urutan sama = bukan leg 2'); assert.equal(aggregateBeforeLeg2(undefined, 20, 10, ts), null);
  const [lh, la] = leg2Multipliers(-2, 0.05); assert(lh > 1 && la < 1, 'tertinggal menyerang lebih banyak');
  assert(isKnockoutRound('Round of 16') && isKnockoutRound('Play-offs') && !isKnockoutRound('Regular Season - 4') && !isKnockoutRound('Group Stage - 2'));
  assert.equal(legKey(1, 2026, 'Round of 16', 20, 10), legKey(1, 2026, 'Round of 16', 10, 20));
  // grup timnas: 4 tim, sekali bertemu (G=3), 2 lolos. A 9 poin (3 laga) sudah lolos; D 0 poin setelah 3 laga sudah gugur.
  const std = [[{ team: { id: 1 }, points: 9, group: 'A', all: { played: 3 } }, { team: { id: 2 }, points: 4, group: 'A', all: { played: 3 } }, { team: { id: 3 }, points: 3, group: 'A', all: { played: 3 } }, { team: { id: 4 }, points: 0, group: 'A', all: { played: 3 } }]];
  const gt = parseGroups(1, std)[0]; assert.equal(gt.G, 3); assert.equal(gt.sure, 2);
  assert.equal(groupState(gt, 1), 'through'); assert.equal(groupState(gt, 4), 'out');
  // sebelum laga terakhir: peringkat 3 (3 poin, 2 laga tersisa? tidak: semua sudah 3 laga) -> pakai tabel lain untuk 'alive'
  const std2 = [[{ team: { id: 1 }, points: 6, group: 'A', all: { played: 2 } }, { team: { id: 2 }, points: 4, group: 'A', all: { played: 2 } }, { team: { id: 3 }, points: 3, group: 'A', all: { played: 2 } }, { team: { id: 4 }, points: 1, group: 'A', all: { played: 2 } }]];
  const g2 = parseGroups(1, std2)[0]; assert.equal(groupState(g2, 1), 'alive', 'seri poin dianggap belum pasti'); assert.equal(groupState(g2, 2), 'alive'); assert.equal(groupState(g2, 4), 'alive');
  // deskripsi API: 1 slot langsung + 1 playoff -> gugur baru pasti bila 2 tim di atas poin maksimumnya
  const std3 = [[{ team: { id: 1 }, points: 9, group: 'B', description: 'Promotion - World Cup', all: { played: 3 } }, { team: { id: 2 }, points: 6, group: 'B', description: 'Play-offs', all: { played: 3 } }, { team: { id: 3 }, points: 3, group: 'B', all: { played: 3 } }, { team: { id: 4 }, points: 0, group: 'B', all: { played: 3 } }]];
  const g3 = parseGroups(32, std3)[0]; assert(g3.sure === 1 && g3.maybe === 2 && g3.G === 6, 'kualifikasi kandang-tandang: G = 6');
  // buildContext: semua sakelar, tag, faktor keyakinan
  const base = { leagueId: 2, season: 2026, round: 'Final', ts, home: { id: 10, name: 'Inter', recent: [ts - 2 * 86400] }, away: { id: 20, name: 'AC Milan', recent: [ts - 7 * 86400] } };
  const cfgF = { ...CFG, ctxFatigueRel: 0.03 }, c = buildContext(base, cfgF)!; const kinds = c.tags.map(t => t.kind).sort();
  assert.deepEqual(kinds, ['derby', 'fatigue', 'final']); assert(c.confFactor < 0.9 && c.mul.home < c.mul.away, 'final+derbi memotong keyakinan; kelelahan menekan tim yang capek');
  assert.equal(CFG.ctxFatigueRel, 0, 'default: kelelahan hanya label'); assert.equal(buildContext(base)!.mul.home * buildContext(base)!.mul.away, buildContext(base)!.mul.home * buildContext(base)!.mul.away);
  assert.equal(buildContext({ ...base, round: 'Regular Season - 3', home: { id: 1, name: 'Foo' }, away: { id: 2, name: 'Bar' } }), null, 'tanpa konteks -> null');
  const off = { ...CFG, ctxFatigue: false, ctxFinal: false, ctxDerby: false }; assert.equal(buildContext(base, off), null, 'sakelar mati');
  const cg = buildContext({ leagueId: 1, season: 2026, round: 'Group Stage - 3', ts, home: { id: 1, name: 'A' }, away: { id: 4, name: 'D' }, group: gt })!;
  assert(cg.info.group?.home === 'through' && cg.info.group?.away === 'out' && cg.tags.some(t => t.kind === 'group'));
  assert(cg.confFactor === 1 && cg.mul.home !== 1 && Math.abs(cg.mul.home * cg.mul.away - 1) < 1e-9, 'lolos vs gugur: efek relatif, total dijaga');
  // engine: pengali & faktor keyakinan terpasang
  const fxC = { fixture: { id: 5, timestamp: ts }, league: { id: 2, name: 'X', season: 2026, round: 'Final' }, teams: { home: { id: 10, name: 'Inter' }, away: { id: 20, name: 'AC Milan' } } };
  const rowC = (rank: number) => ({ rank, form: 'WDLWD', all: { played: 30, goals: { for: 45, against: 40 } }, home: { played: 15, goals: { for: 24, against: 19 } }, away: { played: 15, goals: { for: 21, against: 21 } } });
  const lgC = leagueAverages([rowC(1), rowC(2)]), p0 = buildPrediction(fxC, rowC(3), rowC(4), lgC), p1 = buildPrediction(fxC, rowC(3), rowC(4), lgC, null, null, { ctx: c });
  assert(p1.context && p1.context.tags.length === 3 && p1.conf!.comp < 0.9 && p1.confidence <= p0.confidence, 'keyakinan dipotong');
  assert.equal(p0.context, undefined, 'tanpa ctx -> tanpa field context');
}
// juara & degradasi yang sudah pasti (stakes.ts)
{
  const pts = [80, 60, 55, 50, 48, 45, 44, 42, 41, 40, 39, 38, 37, 36, 35, 34, 30, 22, 15, 10]; // 20 tim, 38 laga, semua main 34 -> 4 laga tersisa (maks 12 poin)
  const all = pts.map(p => ({ pts: p, p: 34 }));
  const c = tableCtx(all, { pts: 80, p: 34 }, { pts: 10, p: 34 }, 20, 38);
  assert.equal(c.rem, 4);
  assert.equal(situation(c, 'home').kind, 'champion'); assert.equal(situation(c, 'home').need, 0); assert.equal(situation(c, 'home').label, 'Sudah juara');
  assert.equal(situation(c, 'away').kind, 'relegated', 'degradasi pasti: 10 + 12 = 22 < 30 (batas aman)');
  const c2 = tableCtx(all, { pts: 68, p: 34 }, { pts: 60, p: 34 }, 20, 38); // rank 2 (bukan pemuncak) -> tidak mungkin 'sudah juara'
  assert.notEqual(situation(c2, 'home').kind, 'champion');
}
{
  // results.ts: jeda antar-laga & leg pertama laga gugur tercatat
  const res = emptyResults(), mk = (id: number, h: number, a: number, hg: number, ag: number, ts: number, round: string) => ({ fixture: { id, timestamp: ts, status: { short: 'FT' } }, league: { id: 2, season: 2026, round }, teams: { home: { id: h, name: 'H' + h }, away: { id: a, name: 'A' + a } }, goals: { home: hg, away: ag }, score: { fulltime: { home: hg, away: ag } } });
  assert(addFixture(res, mk(101, 10, 20, 3, 1, 1e9, 'Round of 16')));
  assert.deepEqual(res.recent![10], [1e9]); assert.deepEqual(res.recent![20], [1e9]);
  const lk = legKey(2, 2026, 'Round of 16', 20, 10); assert.deepEqual(res.legs![lk], { h: 10, a: 20, hg: 3, ag: 1, ts: 1e9 });
  assert(addFixture(res, mk(102, 20, 10, 0, 0, 1e9 + 7 * 86400, 'Round of 16'))); assert.equal(res.legs![lk].hg, 3, 'leg pertama tidak ditimpa leg kedua');
  assert.equal(aggregateBeforeLeg2(res.legs![lk], 20, 10, 1e9 + 8 * 86400), -2);
  assert(addFixture(res, mk(103, 10, 30, 1, 0, 1e9 + 9 * 86400, 'Regular Season - 4'))); assert.equal(Object.keys(res.legs!).length, 1, 'liga biasa tidak masuk daftar leg');
  for (let i = 0; i < 6; i++) addFixture(res, mk(200 + i, 10, 40 + i, 1, 1, 1e9 + (10 + i) * 86400, 'Regular Season - 5')); assert.equal(res.recent![10].length, CFG.recentKeep, 'riwayat dibatasi');
}
console.log('context OK');

// --- v6: konteks laga dari AI (validasi ketat, efek terbatas, cache) ---
import { validateAiCtx, evidenceSupported, scoreIn, sideOfTeam, matchImportance, ctxHint, tableKnown, aiCtxCount } from './aiContext.ts';
import { aiTeamEffect } from './context.ts';
import { aiAbsences } from './news.ts';
{
  const hit = (host: string, content: string) => ({ title: 'x', url: `https://${host}/a`, content });
  const H = [hit('a.com', 'Feyenoord beat Ajax 3-1 in the first leg at De Kuip and lead the tie ahead of the return in Amsterdam'), hit('b.com', 'Ajax boss says he will rotate heavily for the return leg with several starters rested and a reserve squad expected'), hit('c.com', 'Ajax coach confirmed heavy rotation for the second leg and youngsters will start the match')];
  const o = { home: 'Ajax', away: 'Feyenoord', round: 'Round of 16' };
  assert(evidenceSupported('he will rotate heavily for the return leg with several starters rested', H[1].content) && !evidenceSupported('Feyenoord already won the league title this season', H[1].content) && !evidenceSupported('too short', H[1].content), 'bukti harus didukung teks sumber');
  assert(scoreIn('won 3-1 at home', 1, 3) && scoreIn('won 3 – 1', 3, 1) && !scoreIn('won 3-1', 2, 1));
  assert.equal(sideOfTeam('Feyenoord', 'Ajax', 'Feyenoord'), 'away'); assert.equal(sideOfTeam('Ajax Amsterdam', 'Ajax', 'Feyenoord'), 'home'); assert.equal(sideOfTeam('Inter', 'Inter Miami', 'Inter'), null, 'ambigu -> null'); assert.equal(sideOfTeam('Napoli', 'Ajax', 'Feyenoord'), null);
  const good = { sig: [
    { team: 'home', kind: 'rotation', value: 'heavy', s: [2, 3], ev: 'he will rotate heavily for the return leg with several starters rested' },
    { team: 'away', kind: 'status', value: 'champion', s: [1], ev: 'Feyenoord already won the league title this season' },          // karangan -> dibuang
    { team: 'away', kind: 'rotation', value: 'heavy', s: [9], ev: 'coach will rotate heavily for the return leg' },                     // sumber tidak ada -> dibuang
    { team: 'away', kind: 'foo', value: 'x', s: [1], ev: 'Feyenoord beat Ajax 3-1 in the first leg at De Kuip' },                       // kind tak dikenal -> dibuang
    { team: 'home', kind: 'rotation', value: 'some', s: [2], ev: 'he will rotate heavily for the return leg with several starters rested' }, // duplikat (team,kind) -> dibuang
  ], leg1: { home_team: 'Feyenoord', score: '3-1', s: [1], ev: 'Feyenoord beat Ajax 3-1 in the first leg at De Kuip' }, derby: { s: [1], ev: 'Feyenoord beat Ajax 3-1 in the first leg at De Kuip' } };
  const v = validateAiCtx(good, H, o)!;
  assert.equal(v.sigs.length, 1); assert.equal(v.sigs[0].value, 'heavy'); assert.equal(v.nSrc, 3);
  assert.deepEqual(v.leg1 && { hg: v.leg1.hg, ag: v.leg1.ag }, { hg: 1, ag: 3 }, 'Feyenoord tuan rumah leg 1 menang 3-1 -> Ajax (kandang kini) mencetak 1, Feyenoord 3');
  assert.equal(v.derby, undefined, 'Ajax-Feyenoord sudah ada di daftar derbi sistem -> tidak diambil dari AI');
  // rotasi berat dari 1 situs saja -> turun jadi "sebagian"
  assert.equal(validateAiCtx({ sig: [{ team: 'home', kind: 'rotation', value: 'heavy', s: [2], ev: 'he will rotate heavily for the return leg with several starters rested' }] }, H, o)!.sigs[0].value, 'some');
  // sumber kurang dari minimum / masukan bukan objek -> null
  assert.equal(validateAiCtx(good, H.slice(0, 1), o), null); assert.equal(validateAiCtx('abc', H, o), null); assert.equal(validateAiCtx(null, H, o), null);
  // leg 1: skor tidak ada di teks sumber, nama tim ambigu, sistem sudah punya leg 1, atau bukan babak gugur -> dibuang
  const L = (l: any, oo: any = o) => validateAiCtx({ sig: [], leg1: l }, H, oo)!.leg1;
  const l1 = { home_team: 'Feyenoord', score: '3-1', s: [1], ev: 'Feyenoord beat Ajax 3-1 in the first leg at De Kuip' };
  assert(L(l1)); assert.equal(L({ ...l1, score: '4-1' }), undefined); assert.equal(L({ ...l1, home_team: 'Napoli' }), undefined); assert.equal(L(l1, { ...o, hasLeg1: true }), undefined);
  assert.equal(L(l1, { ...o, round: 'Regular Season - 4' }), undefined); assert.equal(L(l1, { ...o, round: 'Final' }), undefined); assert.equal(L({ ...l1, ev: 'Feyenoord beat Ajax in the first leg at De Kuip' }), undefined, 'bukti harus memuat skor');
  // derbi dari AI: perlu kata derbi/rivalitas di kutipan yang didukung sumber
  const HD = [hit('a.com', 'The local derby between Alpha and Beta always brings a tense atmosphere in the city'), hit('b.com', 'Beta face their big rivals Alpha this weekend')];
  assert(validateAiCtx({ sig: [], derby: { s: [1], ev: 'The local derby between Alpha and Beta always brings a tense atmosphere' } }, HD, { home: 'Alpha', away: 'Beta' })!.derby);
  assert.equal(validateAiCtx({ sig: [], derby: { s: [1], ev: 'between Alpha and Beta always brings a tense atmosphere in the city' } }, HD, { home: 'Alpha', away: 'Beta' })!.derby, undefined);

  // efek: hanya menurunkan, dibatasi, tidak dihitung dua kali, skala 0 = tanpa efek
  const ai = validateAiCtx({ sig: [
    { team: 'home', kind: 'rotation', value: 'heavy', s: [2, 3], ev: 'he will rotate heavily for the return leg with several starters rested' },
    { team: 'home', kind: 'status', value: 'qualified', s: [3], ev: 'Ajax coach confirmed heavy rotation for the second leg and youngsters will start' },
    { team: 'home', kind: 'fatigue', value: 'tired', s: [3], ev: 'youngsters will start the match Ajax coach confirmed heavy rotation' },
  ] }, H, o)!;
  assert.equal(ai.sigs.length, 3);
  const e1 = aiTeamEffect(ai, 'home', false); assert(e1.w > 0 && e1.w <= CFG.ctxAiMaxXg + 1e-12 && e1.conf, 'dibatasi'); assert.equal(aiTeamEffect(ai, 'away', false).w, 0);
  const e2 = aiTeamEffect(ai, 'home', true); assert(e2.w < e1.w && !e2.parts.includes('sudah lolos'), 'tabel/grup sudah menilai motivasi -> status AI diabaikan, rotasi setengah');
  assert.equal(aiTeamEffect(ai, 'home', false, { ...CFG, ctxAiScale: 0 }).w, 0);
  // buildContext dengan AI
  const base6 = { leagueId: 2, season: 2026, round: 'Round of 16', ts: 1e9, home: { id: 301, name: 'Ajax' }, away: { id: 300, name: 'Feyenoord' } };
  const c6 = buildContext({ ...base6, ai })!;
  const c6n = buildContext(base6)!, aiConf = c6.confFactor / c6n.confFactor; // Ajax-Feyenoord = derbi sistem (x0,93) -> bandingkan faktor AI saja
  assert(c6.mul.home < 1 && c6.mul.away === 1 && aiConf < 1 && aiConf >= CFG.ctxAiConfMin - 1e-12 && c6.tags.some(t => t.kind === 'ai' && t.ai), 'AI menurunkan xG tim yang merotasi & memotong keyakinan sedikit');
  assert(c6.mul.home >= Math.exp(-CFG.ctxAiMaxXg) - 1e-9, 'penurunan dibatasi'); assert.equal(c6.info.ai?.nSrc, 3);
  const cL = buildContext({ ...base6, ai: v })!; // leg 1 dari AI: Ajax 1 - 3 Feyenoord -> agregat kandang = -2 -> Ajax menyerang lebih banyak, dipercaya 70%
  assert.equal(cL.info.aggHome, -2); assert.equal(cL.info.aggSrc, 'ai'); assert(cL.tags.some(t => t.kind === 'leg2' && t.ai));
  const own = buildContext({ ...base6, leg1: { h: 300, a: 301, hg: 3, ag: 1, ts: 1e9 - 7 * 86400 }, ai: v })!;
  assert.equal(own.info.aggSrc, 'own', 'catatan sendiri didahulukan dari AI'); assert(cL.mul.home > 1 && cL.mul.home < own.mul.home, 'AI dipercaya sebagian');
  const cOff = buildContext({ ...base6, ai }, { ...CFG, ctxAi: false })!; assert(!cOff.tags.some(t => t.ai) && cOff.mul.home === 1 && cOff.info.ai === undefined, 'AI_CONTEXT=false -> tanpa efek AI (derbi sistem tetap)');
  const cLbl = buildContext({ ...base6, ai }, { ...CFG, ctxAiScale: 0 })!; assert(cLbl.mul.home === 1 && cLbl.confFactor === c6n.confFactor && cLbl.tags.some(t => t.ai), 'skala 0 = label saja (xG & keyakinan sama seperti tanpa AI)');
  const cKn = buildContext({ ...base6, ai, tableKnown: { home: true, away: false } })!; assert(cKn.mul.home > c6.mul.home, 'tabel sudah menilai -> efek AI lebih kecil');
  const dAi = buildContext({ leagueId: 1, season: 1, round: 'Regular Season - 3', ts: 1e9, home: { id: 1, name: 'Alpha' }, away: { id: 2, name: 'Beta' }, ai: validateAiCtx({ sig: [], derby: { s: [1], ev: 'The local derby between Alpha and Beta always brings a tense atmosphere' } }, HD, { home: 'Alpha', away: 'Beta' })! })!;
  assert(dAi.tags[0].kind === 'derby' && dAi.tags[0].ai && dAi.confFactor === CFG.ctxDerbyConf && dAi.mul.home === 1);
  assert.equal(aiCtxCount(v), 2); assert(matchImportance({ league: { id: 2, round: 'Final' }, teams: { home: { name: 'A' }, away: { name: 'B' } } }) > matchImportance({ league: { id: 999, round: 'Regular Season - 3' }, teams: { home: { name: 'A' }, away: { name: 'B' } } }));
  assert(/Leg 1 BELUM tercatat/.test(ctxHint({ league: { round: 'Round of 16' }, teams: { home: { name: 'A' }, away: { name: 'B' } } }, null, null, false).text) && ctxHint({ league: { round: 'Round of 16' }, teams: { home: { name: 'A' }, away: { name: 'B' } } }, null, null, true).hasLeg1);
  assert.deepEqual(tableKnown(null), { home: false, away: false });

  // aiAbsences: konteks divalidasi SEBELUM disimpan ke cache; pembacaan dari cache tetap membawa konteks (tanpa panggilan Gemini kedua)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-')), oldDir = CFG.cacheDir, realFetch = globalThis.fetch; let gemCalls = 0, tavCalls = 0;
  CFG.cacheDir = tmp; process.env.TAVILY_API_KEY = 'tv';
  globalThis.fetch = (async (u: any) => {
    const url = String(u);
    if (url.includes('tavily')) { tavCalls++; return new Response(JSON.stringify({ results: H.map(h => ({ title: h.title, url: h.url, content: h.content })) })); }
    gemCalls++; return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify([{ id: 7001, home: [], away: [], ctx: good }]) }] } }] }));
  }) as any;
  try {
    const fx7 = { fixture: { id: 7001, date: '2026-09-30T19:00:00Z', timestamp: 1e9 }, league: { id: 2, name: 'UCL', round: 'Round of 16', season: 2026 }, teams: { home: { id: 301, name: 'Ajax' }, away: { id: 300, name: 'Feyenoord' } } };
    const hints = new Map([[7001, ctxHint(fx7, null, null, false)]]);
    const r1 = await aiAbsences('k', [fx7], new Map(), hints), r2 = await aiAbsences('k', [fx7], new Map(), hints);
    assert.equal(gemCalls, 1, 'panggilan kedua dari cache'); assert.equal(tavCalls, 1);
    for (const r of [r1, r2]) { const c = r.ctx.get(7001)!; assert(c && c.sigs.length === 1 && c.leg1 && c.leg1.hg === 1 && c.nSrc === 3, 'konteks lolos validasi dan tetap ada setelah dibaca dari cache'); }
    assert.equal(r2.nCtx, 1);
    const off = { ...CFG }; CFG.ctxAi = false; const r3 = await aiAbsences('k', [{ ...fx7, fixture: { ...fx7.fixture, id: 7002 } }], new Map()); CFG.ctxAi = off.ctxAi; assert.equal(r3.ctx.size, 0, 'AI_CONTEXT=false -> tanpa konteks');
  } finally { globalThis.fetch = realFetch; CFG.cacheDir = oldDir; delete process.env.TAVILY_API_KEY; }
}
console.log('konteks AI OK');

{
  // multi-key: key 1 habis (batas harian) -> pindah ke key 2; semua habis -> null
  assert.deepEqual(readApiKeys({ FOOTBALL_API_KEY: 'a', FOOTBALL_API_KEY_2: 'b', FOOTBALL_API_KEY_3: '', FOOTBALL_API_KEYS: 'b, c' }), ['a', 'b', 'c']);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-')), 'usage.json');
  const realFetch = globalThis.fetch, seenKeys: string[] = [];
  globalThis.fetch = (async (_u: any, init: any) => {
    const k = init.headers['x-apisports-key']; seenKeys.push(k);
    const body = k === 'K1' ? { errors: { requests: 'You have reached the request limit for the day, Go to https://dashboard.api-football.com' }, response: [] } : { errors: [], response: [{ ok: k }] };
    return new Response(JSON.stringify(body), { headers: { 'x-ratelimit-requests-remaining': k === 'K1' ? '0' : '90' } });
  }) as any;
  try {
    const usage = new ApiUsage(f, 100, 8), api = new FootballApi(['K1', 'K2'], usage);
    const r = await api.get('fixtures', { date: '2026-01-01' }, 0, false);
    assert.deepEqual(r?.data, [{ ok: 'K2' }], 'pindah ke key 2 setelah key 1 habis');
    assert.deepEqual(seenKeys, ['K1', 'K2']);
    await api.get('fixtures', { date: '2026-01-02' }, 0, false);
    assert.equal(seenKeys.filter(k => k === 'K1').length, 1, 'key 1 tidak dicoba lagi hari itu');
    assert.equal(usage.limit, 200);
    const again = new ApiUsage(f, 100, 8); new FootballApi(['K1', 'K2'], again);
    assert.equal(again.pick() !== null, true, 'status habis tersimpan; key 2 masih ada');
    const both = new ApiUsage(f, 100, 8); both.setKeys([keyId('K1')]);
    assert.equal(both.pick(), null, 'hanya key 1 (habis) -> tidak ada key');
  } finally { globalThis.fetch = realFetch; }
}
console.log('multi-key OK');

{
  // Tavily multi-key: key 1 kuota habis (HTTP 432) -> pindah ke key 2; status habis tersimpan; 401 hanya dilewati (tidak disimpan)
  assert.deepEqual(readTavilyKeys({ TAVILY_API_KEY: 'a', TAVILY_API_KEY_2: 'b', TAVILY_API_KEY_3: '', TAVILY_API_KEYS: 'b, c' }), ['a', 'b', 'c']);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tav-')), oldDir = CFG.cacheDir, realFetch = globalThis.fetch, seen: string[] = [];
  const oldEnv = { k1: process.env.TAVILY_API_KEY, k2: process.env.TAVILY_API_KEY_2, k3: process.env.TAVILY_API_KEY_3 };
  CFG.cacheDir = tmp; process.env.TAVILY_API_KEY = 'T1'; process.env.TAVILY_API_KEY_2 = 'T2'; delete process.env.TAVILY_API_KEY_3;
  globalThis.fetch = (async (_u: any, init: any) => {
    const k = String(init.headers.Authorization).replace('Bearer ', ''); seen.push(k);
    if (k === 'T1') return new Response('{"detail":{"error":"This request exceeds your plan\'s set usage limit."}}', { status: 432 });
    return new Response(JSON.stringify({ results: [{ title: 't', url: 'https://x.test/a', content: 'isi' }] }));
  }) as any;
  try {
    const r = await webSearch('q1');
    assert.equal(r.length, 1); assert.deepEqual(seen, ['T1', 'T2'], 'pindah ke key 2 setelah key 1 kena batas kuota');
    await webSearch('q2');
    assert.equal(seen.filter(k => k === 'T1').length, 1, 'key 1 tidak dicoba lagi bulan itu');
    assert(/key1 0\/1000 HABIS/.test(tavilySummary()) && /key2 2\/1000/.test(tavilySummary()), tavilySummary());
    const st = JSON.parse(fs.readFileSync(path.join(tmp, 'tavily_usage.json'), 'utf8')); assert.equal(Object.values<any>(st.keys).filter(x => x.exhausted).length, 1);
  } finally { globalThis.fetch = realFetch; CFG.cacheDir = oldDir; for (const [n, v] of [['TAVILY_API_KEY', oldEnv.k1], ['TAVILY_API_KEY_2', oldEnv.k2], ['TAVILY_API_KEY_3', oldEnv.k3]] as const) { if (v === undefined) delete process.env[n]; else process.env[n] = v; } }
}
console.log('tavily multi-key OK');
