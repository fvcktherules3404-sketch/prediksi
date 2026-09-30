import type { Prediction } from './types.ts';

/** Jenis pilihan pasar. Double chance SENGAJA tidak ada di sini. */
export type OptKind = '1x2' | 'hdpFav' | 'hdpDog' | 'ou' | 'btts';
export interface PickOpt {
  kind: OptKind;
  /** Penanda pasar yang tampil kecil: 1X2 / HDP - / HDP + / O/U / BTTS */
  tag: string;
  label: string;
  /** Peluang (untuk HDP: porsi kemenangan, push dihitung setengah) */
  p: number;
  /** Ketegasan 0..1, skalanya sebanding antar pasar */
  strength: number;
  /** true bila p >= minP (layak dijadikan saran) */
  strong: boolean;
  /** Khusus HDP: sisi ('1' kandang / '2' tandang) dan garisnya */
  side?: '1' | '2';
  line?: number;
}

export const MIN_P = 0.6;
const fmt = (l: number) => (l > 0 ? `+${l}` : `${l}`);
const short = (n: string) => (n.length > 14 ? n.slice(0, 13) + '…' : n);
/** Porsi kemenangan handicap: menang 1, setengah menang .75, push .5, setengah kalah .25, kalah 0 */
const eff = (win: number, halfWin: number, push: number, halfLoss: number) => win + 0.75 * halfWin + 0.5 * push + 0.25 * halfLoss;

type Src = Pick<Prediction, 'probs' | 'home' | 'away' | 'ou' | 'btts' | 'handicap'>;

/**
 * Semua pilihan pasar untuk satu laga:
 *  - main   : 1X2 (tim menang / seri dengan peluang tertinggi)
 *  - others : pilihan lain yang tersedia, urut ketegasan tertinggi:
 *             HDP - (tim unggulan, garis terberat yang masih >= minP),
 *             HDP + (tim non-unggulan, garis teringan yang masih >= minP),
 *             Over/Under 2.5, BTTS
 *  - best   : others[0] = "peluang terbesar lainnya" (selalu ada karena O/U & BTTS selalu tersedia)
 */
export function pickOptions(p: Src, minP = MIN_P): { main: PickOpt; others: PickOpt[]; best: PickOpt } {
  const { home: h, draw: d, away: a } = p.probs;
  const top = h >= d && h >= a ? '1' : a >= h && a >= d ? '2' : 'X';
  const pTop = top === '1' ? h : top === '2' ? a : d;
  const main: PickOpt = {
    kind: '1x2', tag: '1X2',
    label: top === '1' ? `${p.home.name} menang` : top === '2' ? `${p.away.name} menang` : 'Seri',
    p: pTop, strength: (pTop - 1 / 3) / (2 / 3), strong: true,
  };
  const others: PickOpt[] = [];

  const o = p.ou?.find(x => x.line === 2.5) ?? p.ou?.[1];
  if (o) {
    const over = o.over >= 0.5, pO = over ? o.over : o.under;
    others.push({ kind: 'ou', tag: 'O/U', label: `${over ? 'Over' : 'Under'} 2.5`, p: pO, strength: ((pO - 0.5) / 0.5) * 0.95, strong: pO >= minP });
  }
  const yes = p.btts.yes >= 0.5, pB = yes ? p.btts.yes : p.btts.no;
  others.push({ kind: 'btts', tag: 'BTTS', label: yes ? 'Ya' : 'Tidak', p: pB, strength: ((pB - 0.5) / 0.5) * 0.95, strong: pB >= minP });

  // handicap[] berisi garis untuk tuan rumah; sisi tandang = cermin (garis dibalik, hasil dibalik)
  const favHome = h >= a;
  const side = (isHome: boolean) => (p.handicap ?? []).map(x => ({
    line: isHome ? x.line : -x.line,
    e: isHome ? eff(x.win, x.halfWin, x.push, x.halfLoss) : eff(x.loss, x.halfLoss, x.push, x.halfWin),
  }));
  // HDP - : unggulan, garis negatif paling berat yang masih lolos
  let fav: { line: number; e: number } | null = null;
  for (const x of side(favHome)) if (x.line < 0 && x.line >= -1.5 && x.e >= minP && (!fav || x.line < fav.line)) fav = x;
  if (fav) others.push({ kind: 'hdpFav', tag: 'HDP -', label: `${short(favHome ? p.home.name : p.away.name)} ${fmt(fav.line)}`, p: fav.e, strength: ((fav.e - 0.5) / 0.5) * 0.9, strong: true, side: favHome ? '1' : '2', line: fav.line });
  // HDP + : non-unggulan, garis positif paling ringan (paling berani) yang masih lolos
  let dog: { line: number; e: number } | null = null;
  for (const x of side(!favHome)) if (x.line > 0 && x.line <= 2 && x.e >= minP && (!dog || x.line < dog.line)) dog = x;
  if (dog) others.push({ kind: 'hdpDog', tag: 'HDP +', label: `${short(favHome ? p.away.name : p.home.name)} ${fmt(dog.line)}`, p: dog.e, strength: ((dog.e - 0.5) / 0.5) * 0.9, strong: true, side: favHome ? '2' : '1', line: dog.line });

  others.sort((x, y) => y.strength - x.strength);
  return { main, others, best: others[0] };
}

/**
 * Pick HDP untuk satu laga (chip "HDP" di kartu & penilaian di Riwayat): HDP - bila tim unggulan, HDP + bila tim lemah, mana yang lebih tegas.
 * Dicari dari peluang >= minP; bila tidak ada, ambang diturunkan bertahap (0.55 lalu 0.5) supaya laga tetap punya pick HDP.
 */
export function hdpPick(p: Src, minP = MIN_P): PickOpt | undefined {
  for (const t of [minP, 0.55, 0.5]) {
    const o = pickOptions(p, Math.min(t, minP)).others.find(x => x.kind === 'hdpFav' || x.kind === 'hdpDog');
    if (o) return o;
  }
  return undefined;
}
