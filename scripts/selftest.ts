import assert from 'node:assert';
import { scoreMatrix, ahLine, buildPrediction, leagueAverages } from './engine.ts';
import { computeWindow } from './run.ts';

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
console.log('OK', JSON.stringify({ xg: p.xg, probs: p.probs, fair: p.fairHandicap, conf: p.confidence, pick: p.picks }));
