/** ===== KONTEKS TABEL & TARUHAN LAGA (v3) =====
 * Membaca posisi tiap tim di tabel: berebut juara, berebut/menjaga 4 besar, terancam degradasi, atau sudah "aman" (tanpa target).
 * Struktur yang sama dipakai backtest.ts (dari hasil lama) dan run.ts/engine.ts (dari klasemen live).
 * Catatan jujur: backtest (docs/BACKTEST.md, bagian H) menunjukkan efek ini KECIL. Pengaruh ke xG dikendalikan CFG.stakes* dan
 * hanya aktif kalau backtest membuktikan perbaikan. Label situasi tetap ditampilkan sebagai konteks. */
export interface TeamPts { pts: number; p: number }
export interface TableCtx {
  N: number; G: number;                 // jumlah tim liga, jumlah laga per tim se-musim (kompetisi kandang-tandang)
  gpH: number; gpA: number;             // laga yang sudah dimainkan kandang / tandang
  ptsH: number; ptsA: number; rankH: number; rankA: number;
  top: number; second: number;          // poin peringkat 1 & 2
  c4: number; c5: number;               // poin peringkat 4 & 5 (garis 4 besar)
  safe: number; drop: number;           // poin tim terbawah yang masih aman & tim tertinggi di zona degradasi
}
export const nRelegated = (N: number) => (N >= 18 ? 3 : 2);

/** Bangun konteks tabel. `all` = semua tim yang tercatat (yang belum tercatat dianggap 0 poin sampai N). */
export function tableCtx(all: TeamPts[], home: TeamPts, away: TeamPts, N: number, G: number): TableCtx {
  const pts = all.map(e => e.pts); while (pts.length < N) pts.push(0);
  const sp = [...pts].sort((a, b) => b - a), nr = nRelegated(N), rank = (p: number) => 1 + sp.filter(v => v > p).length;
  return { N, G, gpH: home.p, gpA: away.p, ptsH: home.pts, ptsA: away.pts, rankH: rank(home.pts), rankA: rank(away.pts),
    top: sp[0], second: sp[1], c4: sp[3], c5: sp[4], safe: sp[N - nr - 1], drop: sp[N - nr] };
}

export type StakeKind = 'title' | 'europe' | 'safe' | 'relegation';
export interface Situation {
  kind: StakeKind;
  /** 1 = sedang berebut sesuatu (tepat di garis), 0 = tanpa target. */
  need: number;
  /** true bila tim berada di sisi "atas" garis terdekatnya (menjaga posisi), false bila mengejar. */
  defending: boolean;
  label: string;
}
const DIST_SCALE = 0.3; // jarak ke garis dinormalisasi sisa poin maksimum (3 x sisa laga), lalu need = exp(-jarak/DIST_SCALE)

/** Situasi satu tim: garis terdekat dari {juara, batas 4 besar, batas degradasi}, jaraknya dibanding poin yang masih bisa diambil. */
export function situation(c: TableCtx, side: 'home' | 'away'): Situation {
  const pts = side === 'home' ? c.ptsH : c.ptsA, gp = side === 'home' ? c.gpH : c.gpA, rank = side === 'home' ? c.rankH : c.rankA;
  const M = 3 * Math.max(0, c.G - gp) + 3;
  const lines: { kind: StakeKind; at: number }[] = [
    { kind: 'title', at: rank === 1 ? c.second : c.top },       // pemuncak: jarak ke pengejar; lainnya: jarak ke pemuncak
    { kind: 'europe', at: rank <= 4 ? c.c5 : c.c4 },            // anggota 4 besar: jarak ke peringkat 5; lainnya: jarak ke peringkat 4
    { kind: 'relegation', at: (c.safe + c.drop) / 2 },
  ];
  let best = lines[0], bd = Infinity;
  for (const l of lines) { const d = Math.abs(pts - l.at); if (d < bd) { bd = d; best = l; } }
  const need = Math.exp(-(bd / M) / DIST_SCALE), defending = pts >= best.at;
  const live = need >= 0.35;
  const kind: StakeKind = live ? best.kind : 'safe';
  const label = !live ? 'Aman / tanpa target'
    : best.kind === 'title' ? (defending ? 'Menjaga puncak' : 'Mengejar juara')
    : best.kind === 'europe' ? (defending ? 'Menjaga 4 besar' : 'Mengejar 4 besar')
    : (defending ? 'Menjauh dari degradasi' : 'Terancam degradasi');
  return { kind, need, defending, label };
}

/** Progres musim 0..1 = rata-rata laga yang sudah dimainkan kedua tim / laga per tim se-musim. */
export const seasonPhase = (c: TableCtx) => Math.min(1, Math.max(0, (c.gpH + c.gpA) / 2 / c.G));

export interface StakeParams { rel: number; level: number; phase: number; need0: number }
/** Pengali xG (kandang, tandang).
 *  rel   : efek RELATIF, total gol dijaga. Tim dengan kebutuhan lebih besar dari lawannya (mengejar / berebut) mencetak lebih banyak, lawan yang "sudah aman" lebih sedikit.
 *  level : efek LEVEL pada total gol: kedua tim sama-sama berebut sesuatu (need rata-rata di atas need0) -> total gol berubah.
 *  phase : elastisitas total gol terhadap progres musim (positif = makin banyak gol di akhir musim, negatif = makin sedikit).
 *  Semua 0 => tanpa efek. */
export function stakeMultipliers(c: TableCtx, sp: StakeParams): { home: number; away: number; sitH: Situation; sitA: Situation; phase: number } {
  const sitH = situation(c, 'home'), sitA = situation(c, 'away'), ph = seasonPhase(c);
  const diff = (sitH.need - sitA.need) / 2, lvl = sp.level * ((sitH.need + sitA.need) / 2 - sp.need0) + sp.phase * (ph - 0.5);
  return { home: Math.exp(sp.rel * diff + lvl), away: Math.exp(-sp.rel * diff + lvl), sitH, sitA, phase: ph };
}
