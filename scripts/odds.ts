import { CFG } from './config.ts';
import type { FootballApi } from './footballApi.ts';
import { readCache, writeCache } from './cache.ts';
import type { MarketInfo } from '../shared/types.ts';

/** ===== Odds pasar sebagai SINYAL STATISTIK =====
 * Odds bandar mengandung banyak informasi yang tidak dimiliki model (kabar tim, susunan, uang pintar).
 * Di sini odds diubah menjadi probabilitas "bersih" (margin bandar dibuang) lalu digabung dengan model di engine.ts.
 * Tidak ada odds yang ditampilkan sebagai saran taruhan. */

const num = (x: unknown) => { const v = Number(x); return Number.isFinite(v) ? v : NaN; };

/** Buang margin dengan metode pangkat (power): cari k sehingga sum(1/odds)^k = 1. Lebih baik dari pembagian proporsional
 *  karena tidak melebih-lebihkan peluang tim underdog (favorite-longshot bias). null bila odds/overround tak masuk akal. */
export function devig(odds: number[], maxOver = 1.25): number[] | null {
  if (odds.length < 2 || odds.some(o => !(o > 1.01 && o < 1000))) return null;
  const inv = odds.map(o => 1 / o), s = inv.reduce((a, b) => a + b, 0);
  if (s < 0.98 || s > maxOver) return null;
  let lo = 0.5, hi = 4;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2, f = inv.reduce((a, x) => a + Math.pow(x, mid), 0);
    if (f > 1) lo = mid; else hi = mid;
  }
  const k = (lo + hi) / 2, p = inv.map(x => Math.pow(x, k)), z = p.reduce((a, b) => a + b, 0);
  return p.map(x => x / z);
}

const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y), n = a.length; return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2; };
const findBet = (bets: any[], id: number, re: RegExp) => (bets ?? []).find((x: any) => x?.id === id || re.test(String(x?.name ?? '')));
const oddOf = (bet: any, label: string) => num(bet?.values?.find((v: any) => String(v?.value).trim().toLowerCase() === label)?.odd);

/** Ubah respons /odds?fixture=ID menjadi satu MarketInfo (rata-rata berbobot antar bandar, bandar tajam 3x, pencilan dibuang). */
export function parseMarket(resp: any[]): MarketInfo | null {
  const bms: any[] = resp?.[0]?.bookmakers ?? [];
  const rows: { w: number; p: number[]; o?: number }[] = [];
  for (const b of bms) {
    const name = String(b?.name ?? '').toLowerCase(), w = CFG.sharpBooks.some(s => name.includes(s)) ? 3 : 1;
    const mw = findBet(b?.bets, 1, /^match winner$/i);
    const p = mw ? devig([oddOf(mw, 'home'), oddOf(mw, 'draw'), oddOf(mw, 'away')]) : null;
    if (!p) continue;
    const ou = findBet(b?.bets, 5, /^goals over\/under$/i), q = ou ? devig([oddOf(ou, 'over 2.5'), oddOf(ou, 'under 2.5')], 1.2) : null;
    rows.push({ w, p, o: q ? q[0] : undefined });
  }
  if (!rows.length) return null;
  let use = rows;
  if (rows.length >= 4) { // buang bandar yang menyimpang jauh dari median (odds basi/salah)
    const med = [0, 1, 2].map(i => median(rows.map(r => r.p[i])));
    const kept = rows.filter(r => r.p.every((x, i) => Math.abs(x - med[i]) <= 0.12));
    if (kept.length >= 3) use = kept;
  }
  const ws = use.reduce((a, r) => a + r.w, 0), avg = [0, 1, 2].map(i => use.reduce((a, r) => a + r.w * r.p[i], 0) / ws);
  const z = avg.reduce((a, b) => a + b, 0), os = use.filter(r => r.o !== undefined), wo = os.reduce((a, r) => a + r.w, 0);
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return { home: r3(avg[0] / z), draw: r3(avg[1] / z), away: r3(avg[2] / z), over25: wo ? r3(os.reduce((a, r) => a + r.w * (r.o as number), 0) / wo) : undefined, books: use.length };
}

/** Ambil odds tiap laga (urut jam kick-off, maks CFG.oddsMaxRequests). Hasil ringkas di-cache `mkt_<id>` selama oddsTtlH.
 *  Gagal/kuota habis/tidak ada odds -> laga itu diprediksi tanpa pasar (tidak pernah dikarang). */
export async function collectOdds(api: FootballApi, fixtures: any[], budget = CFG.oddsMaxRequests, into = new Map<number, MarketInfo>(), keepOrder = false) {
  const map = into; let requested = 0;
  if (!CFG.useOdds) return { map, requested };
  // Prioritas: urutan liga di CFG.leagues (liga besar dulu), lalu jam kickoff. Liga di luar daftar paling belakang.
  const pr = (f: any) => { const i = CFG.leagues.indexOf(f.league.id); return i < 0 ? 999 : i; };
  const list = keepOrder ? [...fixtures] : [...fixtures].sort((a, b) => pr(a) - pr(b) || a.fixture.timestamp - b.fixture.timestamp);
  for (const f of list) {
    const id = f.fixture.id as number, key = `mkt_${id}`;
    const c = readCache<MarketInfo | null>(CFG.cacheDir, key);
    if (c && (Date.now() - c.ts) / 3.6e6 <= CFG.oddsTtlH) { if (c.data) map.set(id, c.data); continue; }
    if (requested >= budget) break;
    requested++;
    const r = await api.get('odds', { fixture: id }, 0, false); // respons besar: jangan simpan mentah ke repo
    if (!r) continue; // gagal/kuota: jangan cache "kosong"
    const m = parseMarket(r.data);
    writeCache(CFG.cacheDir, key, m); // null = memang belum ada odds -> jangan tanya lagi selama TTL (hemat kuota)
    if (m) map.set(id, m);
  }
  console.log(`[odds] ${map.size}/${list.length} laga punya odds pasar (${requested} request)`);
  return { map, requested };
}
