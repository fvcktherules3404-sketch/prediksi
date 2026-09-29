import type { Headline, Prediction } from '../shared/types.ts';

const pc = (x: number) => Math.round(x * 100);
const fmt = (l: number) => (l > 0 ? `+${l}` : `${l}`);
const short = (n: string) => (n.length > 14 ? n.slice(0, 13) + '…' : n);

/** "Porsi kemenangan" handicap satu sisi: menang penuh 1, setengah menang .75, push .5, setengah kalah .25, kalah 0.
 *  Push tidak dibuang (garis 0 / bulat tampak 'aman' padahal seri hanya mengembalikan taruhan), jadi sebanding dengan pasar lain. */
function eff(win: number, halfWin: number, push: number, halfLoss: number) { return win + 0.75 * halfWin + 0.5 * push + 0.25 * halfLoss; }

/**
 * Prediksi utama = satu pilihan dari empat pasar: tim/seri (1X2), HDP, Over/Under, BTTS.
 * Tiap kandidat diberi "ketegasan" 0..1 dengan skala yang sebanding:
 *  - 1X2: (p - 1/3) / (2/3)  |  pasar dua arah (O/U, BTTS, HDP): (p - 0.5) / 0.5.
 * Pasar dua arah hanya dipilih bila p >= headlineMinP; selain itu jatuh ke 1X2 (selalu ada).
 * HDP: sisi favorit pada garis TERBERAT yang porsi kemenangannya (lihat eff) masih >= minP (garis lebih berat = odds lebih tinggi, tetap masuk akal).
 * Bobot kecil menahan 1X2 agar tidak selalu menang: 1X2 mudah punya p tinggi tetapi nilai informasinya lebih rendah.
 */
export function pickHeadline(p: Pick<Prediction, 'probs' | 'home' | 'away' | 'ou' | 'btts' | 'handicap' | 'picks'>, minP = 0.6): Headline {
  const { home: h, draw: d, away: a } = p.probs, hn = short(p.home.name), an = short(p.away.name);
  const top = h >= d && h >= a ? '1' : a >= h && a >= d ? '2' : 'X';
  const pTop = top === '1' ? h : top === '2' ? a : d;
  const label1 = top === '1' ? p.home.name : top === '2' ? p.away.name : 'Seri';
  const cands: Headline[] = [{ market: '1x2', label: label1, sub: top === 'X' ? 'Seri' : 'Menang', p: pTop, strength: (pTop - 1 / 3) / (2 / 3) }];

  const o = p.ou[1], over = o.over >= 0.5;
  const pO = over ? o.over : o.under;
  if (pO >= minP) cands.push({ market: 'ou', label: `${over ? 'Over' : 'Under'} 2.5`, sub: 'Total gol', p: pO, strength: ((pO - 0.5) / 0.5) * 0.95 });

  const yes = p.btts.yes >= 0.5, pB = yes ? p.btts.yes : p.btts.no;
  if (pB >= minP) cands.push({ market: 'btts', label: `BTTS ${yes ? 'Ya' : 'Tidak'}`, sub: yes ? 'Kedua tim cetak gol' : 'Salah satu tim nirbobol', p: pB, strength: ((pB - 0.5) / 0.5) * 0.95 });

  // HDP: favorit = sisi dengan peluang menang lebih besar. handicap[] berisi garis untuk tuan rumah; sisi tandang = cermin.
  const fav = h >= a ? '1' : '2';
  let best: { line: number; e: number } | null = null;
  for (const x of p.handicap) {
    const line = fav === '1' ? x.line : -x.line;
    const e = fav === '1' ? eff(x.win, x.halfWin, x.push, x.halfLoss) : eff(x.loss, x.halfLoss, x.push, x.halfWin);
    if (e >= minP && (!best || line < best.line)) best = { line, e }; // garis paling "berat" yang masih lolos
  }
  if (best && Math.abs(best.line) <= 1.5 && best.line <= 0.5) cands.push({ market: 'hdp', label: `${fav === '1' ? hn : an} ${fmt(best.line)}`, sub: 'HDP', p: best.e, strength: ((best.e - 0.5) / 0.5) * 0.9 });

  return cands.reduce((b, c) => (c.strength > b.strength ? c : b));
}
