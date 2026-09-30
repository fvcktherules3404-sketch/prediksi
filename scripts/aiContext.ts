import { CFG } from './config.ts';
import { tokens } from './standings.ts';
import { situation, type TableCtx } from './stakes.ts';
import { isDerby, isFinalRound, isKnockoutRound, type AiKnown } from './context.ts';
import type { MatchContext } from '../shared/types.ts';
import type { WebHit } from './search.ts';

/** ===== KONTEKS LAGA DARI AI (v6) =====
 * Gemini membaca hasil pencarian web (Tavily) yang SUDAH diambil untuk berita cedera (searchMatch, di-cache per laga), jadi tidak ada
 * kredit Tavily maupun panggilan Gemini tambahan: permintaan konteks ikut di dalam prompt berita yang sudah ada (news.ts).
 * AI hanya boleh melaporkan hal yang TIDAK bisa dihitung dari angka: rotasi pemain yang diumumkan, motivasi (sudah juara / aman /
 * sudah gugur / fokus ke laga lain), kelelahan nyata (120 menit, perjalanan jauh), skor leg 1 yang belum tercatat, dan derbi.
 * Semua keluaran AI divalidasi KETAT di sini SEBELUM dipakai atau disimpan ke cache (jumlah sumber web hanya diketahui saat panggilan):
 *   - ada cukup sumber web, indeks sumber yang dikutip harus ada;
 *   - bukti (potongan kalimat asli dari SUMBER) harus benar-benar didukung teks sumber yang dikutip;
 *   - rotasi "berat" wajib didukung >= 2 situs berbeda, kalau tidak diturunkan jadi "sebagian";
 *   - skor leg 1 harus muncul di teks sumber dan arah kandang/tandangnya dicocokkan lewat NAMA tim, bukan tebakan AI.
 * Efek pada xG kecil dan dibatasi (lihat CFG.ctxAi*). Bukti historis untuk efek ini TIDAK ada di repo (tidak bisa di-backtest),
 * jadi semuanya bisa dimatikan (AI_CONTEXT=false) atau dijadikan label saja (CTX_AI_SCALE=0). */

export type AiKind = 'rotation' | 'motivation' | 'status' | 'fatigue';
export interface AiSig { team: 'home' | 'away'; kind: AiKind; value: string; ev: string; hosts: string[] }
export interface AiCtx {
  nSrc: number; sigs: AiSig[];
  /** gol di leg 1 untuk tim kandang SEKARANG (hg) dan tim tandang sekarang (ag). Hanya bila sistem belum punya leg 1. */
  leg1?: { hg: number; ag: number; ev: string; host: string };
  derby?: { ev: string; host: string };
}
const VALUES: Record<AiKind, string[]> = { rotation: ['some', 'heavy'], motivation: ['low'], status: ['champion', 'relegated', 'qualified', 'eliminated'], fatigue: ['tired'] };

// ---------------------------------------------------------------- Validasi
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ');
const hitText = (h: WebHit) => fold(`${h.title} ${h.content}`);
const hostOf = (h: WebHit) => { try { return new URL(h.url).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** Bukti = potongan kalimat ASLI dari SUMBER. Didukung bila >= 60% kata bermakna (>= 4 huruf, min. 3 kata) ada di teks sumber. */
export function evidenceSupported(ev: string, text: string): boolean {
  const toks = [...new Set(fold(ev).match(/[a-z0-9]{4,}/g) ?? [])];
  if (toks.length < 3) return false;
  const t = fold(text); let found = 0; for (const w of toks) if (t.includes(w)) found++;
  return found / toks.length >= 0.6;
}
/** Apakah `text` memuat skor a-b (urutan bebas) dengan pemisah - – — atau :. */
export function scoreIn(text: string, a: number, b: number): boolean {
  for (const m of text.matchAll(/(\d{1,2})\s*[-–—:]\s*(\d{1,2})/g)) { const x = Number(m[1]), y = Number(m[2]); if ((x === a && y === b) || (x === b && y === a)) return true; }
  return false;
}
/** Sisi (home/away) yang cocok dengan nama tim; ambigu atau tidak cocok -> null. */
export function sideOfTeam(name: string, home: string, away: string): 'home' | 'away' | null {
  const n = tokens(name); if (!n.length) return null;
  const m = (o: string) => { const t = tokens(o); return t.length > 0 && (t.join(' ') === n.join(' ') || t.every(x => n.includes(x)) || n.every(x => t.includes(x))); };
  const h = m(home), a = m(away); return h && !a ? 'home' : a && !h ? 'away' : null;
}
const DERBY_WORDS = /derb(y|i)|rival|cl[aá]sico|classico|klassieker|old firm|el gran|city clash/i;

export interface ValidateOpts { home: string; away: string; round?: string | null; hasLeg1?: boolean }
/** Validasi satu objek `ctx` dari Gemini terhadap daftar sumber `hits` (indeks 1..n = [S1]..[Sn]). Tidak pernah memperbaiki, hanya membuang.
 *  Mengembalikan null bila masukan bukan objek atau sumber web kurang dari CFG.ctxAiMinSrc. */
export function validateAiCtx(x: any, hits: WebHit[], o: ValidateOpts): AiCtx | null {
  if (!x || typeof x !== 'object' || hits.length < CFG.ctxAiMinSrc) return null;
  const n = hits.length, idxOf = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter(i => Number.isInteger(i) && i >= 1 && i <= n))].slice(0, 3);
  const text = (idx: number[]) => idx.map(i => hitText(hits[i - 1])).join(' ');
  const hosts = (idx: number[]) => [...new Set(idx.map(i => hostOf(hits[i - 1])).filter(Boolean))];
  const ev = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 160) : '');
  const out: AiCtx = { nSrc: n, sigs: [] }, seen = new Set<string>();
  for (const r of (Array.isArray(x.sig) ? x.sig : []).slice(0, 12)) {
    const team = r?.team === 'home' || r?.team === 'away' ? r.team as 'home' | 'away' : null, kind = String(r?.kind ?? '') as AiKind;
    if (!team || !VALUES[kind]) continue;
    let value = String(r?.value ?? '').trim().toLowerCase(); if (!VALUES[kind].includes(value)) continue;
    const idx = idxOf(r?.s), e = ev(r?.ev); if (!idx.length || e.length < 12 || !evidenceSupported(e, text(idx))) continue;
    const hs = hosts(idx); if (kind === 'rotation' && value === 'heavy' && hs.length < 2) value = 'some'; // rotasi berat butuh 2 situs berbeda
    const key = `${team}|${kind}`; if (seen.has(key)) continue; seen.add(key);
    out.sigs.push({ team, kind, value, ev: e, hosts: hs });
  }
  // leg 1: hanya bila sistem belum mencatatnya, babak gugur non-final; skor harus ada di teks sumber; arah lewat NAMA tim tuan rumah leg 1
  const l = x.leg1;
  if (l && typeof l === 'object' && !o.hasLeg1 && isKnockoutRound(o.round) && !isFinalRound(o.round)) {
    const m = /^(\d{1,2})\s*[-–—:]\s*(\d{1,2})$/.exec(String(l.score ?? '').trim()), side = sideOfTeam(String(l.home_team ?? ''), o.home, o.away), idx = idxOf(l.s), e = ev(l.ev);
    if (m && side && idx.length && Number(m[1]) <= 9 && Number(m[2]) <= 9 && scoreIn(text(idx), Number(m[1]), Number(m[2])) && scoreIn(e, Number(m[1]), Number(m[2])) && evidenceSupported(e, text(idx))) {
      const g1 = Number(m[1]), g2 = Number(m[2]); // g1 = gol tuan rumah leg 1
      out.leg1 = side === 'home' ? { hg: g1, ag: g2, ev: e, host: hosts(idx)[0] ?? '' } : { hg: g2, ag: g1, ev: e, host: hosts(idx)[0] ?? '' };
    }
  }
  const d = x.derby;
  if (d && typeof d === 'object' && !isDerby(o.home, o.away)) {
    const idx = idxOf(d.s), e = ev(d.ev); if (idx.length && DERBY_WORDS.test(e) && evidenceSupported(e, text(idx))) out.derby = { ev: e, host: hosts(idx)[0] ?? '' };
  }
  return out;
}
export const aiCtxCount = (a?: AiCtx | null) => (a ? a.sigs.length + (a.leg1 ? 1 : 0) + (a.derby ? 1 : 0) : 0);

// ---------------------------------------------------------------- Petunjuk untuk prompt & prioritas
/** Situasi tabel sudah dinilai sistem (aman / juara / degradasi)? Dipakai agar motivasi tidak dihitung dua kali. */
export const tableKnown = (t: TableCtx | null | undefined): AiKnown => t ? { home: situation(t, 'home').need < 0.35, away: situation(t, 'away').need < 0.35 } : { home: false, away: false };

export interface CtxHint { text: string; hasLeg1: boolean }
/** Baris "SISTEM SUDAH TAHU" untuk prompt: apa yang sudah dihitung sistem, agar AI tidak mengulang dan tahu apa yang masih dicari. */
export function ctxHint(f: any, sys: MatchContext | null, table: TableCtx | null, hasLeg1: boolean): CtxHint {
  const round = String(f.league?.round ?? ''), known: string[] = [];
  if (sys?.tags.length) known.push(...sys.tags.map(t => t.label));
  if (table) { const sh = situation(table, 'home'), sa = situation(table, 'away'); known.push(`tabel: ${f.teams.home.name} = ${sh.label}; ${f.teams.away.name} = ${sa.label}`); }
  const ko = isKnockoutRound(round) && !isFinalRound(round);
  return { hasLeg1, text: `Babak: ${round || '-'}. Sistem sudah tahu: ${known.length ? known.join(' | ') : '-'}.` + (ko ? (hasLeg1 ? ' Leg 1 sudah tercatat.' : ' Leg 1 BELUM tercatat: bila laga ini leg kedua, laporkan skor leg 1 (leg1).') : '') };
}
/** Skor kepentingan laga untuk urutan pemrosesan berita/konteks (kuota Gemini & Tavily terbatas: laga penting didahulukan). */
export function matchImportance(f: any): number {
  const round = String(f.league?.round ?? ''); let s = 0;
  if (isFinalRound(round)) s += 5; else if (isKnockoutRound(round)) s += 3;
  if (isDerby(f.teams.home.name, f.teams.away.name)) s += 3;
  if (CFG.groupLeagues.has(f.league.id) && /group|league (stage|phase)|regular season/i.test(round)) s += 3;
  else if (CFG.nationalLeagues.has(f.league.id)) s += 1;
  if (CFG.stakesLeagues.has(f.league.id)) s += 1;
  return s;
}

/** Potongan prompt: permintaan konteks tambahan pada prompt berita. Balasan per laga memuat field "ctx". */
export const CTX_PROMPT =
  `\n\nTAMBAHAN (field "ctx" per laga). Selain absen, laporkan konteks berikut HANYA bila tertulis jelas di SUMBER laga itu. ` +
  `"sig" = daftar sinyal: {"team":"home"|"away","kind":...,"value":...,"s":[nomor sumber],"ev":kutipan}. kind/value yang boleh: ` +
  `rotation = "some" (beberapa starter diistirahatkan) atau "heavy" (pelatih/berita menyebut skuad cadangan/rotasi besar); ` +
  `motivation = "low" (tidak ada yang diperjuangkan atau pelatih memprioritaskan laga lain); ` +
  `status = "champion" | "relegated" | "qualified" | "eliminated" (sudah juara / sudah degradasi / sudah lolos / sudah gugur, hanya bila sumber menyatakan pasti); ` +
  `fatigue = "tired" (kelelahan nyata: perpanjangan waktu, perjalanan jauh, jadwal sangat padat). ` +
  `JANGAN memasukkan cedera/skorsing sebagai rotasi (itu sudah ada di daftar absen). "s" = nomor [S#] yang mendukung. ` +
  `"ev" = potongan kalimat ASLI dari sumber tersebut dalam bahasa aslinya (maks 25 kata), BUKAN terjemahan atau ringkasanmu; sinyal tanpa kutipan asli akan dibuang. ` +
  `"leg1" (opsional, hanya untuk leg kedua babak gugur yang leg 1-nya belum tercatat): {"home_team":nama tim yang menjadi TUAN RUMAH di leg 1,"score":"gol tuan rumah leg 1-gol tamu leg 1","s":[..],"ev":kutipan asli yang memuat skor}. ` +
  `"derby" (opsional): {"s":[..],"ev":kutipan asli yang menyebut derbi/rivalitas} hanya bila sistem belum menandainya. ` +
  `Jika tidak ada yang jelas, isi "ctx":{"sig":[]}. JANGAN menebak.`;
