import { CFG } from './config.ts';
import { tokens } from './standings.ts';
import type { MatchContext, CtxTag, GroupState } from '../shared/types.ts';
import type { AiCtx } from './aiContext.ts';

/** ===== KONTEKS LAGA (v5) =====
 * Faktor di luar tabel liga domestik: final, derbi, leg kedua (agregat), kelelahan (jeda antar-laga), dan situasi grup timnas
 * (sudah lolos / sudah gugur / masih berebut). Semua fungsi murni (tanpa I/O) supaya bisa diuji dan dipakai backtest.
 * Catatan jujur: hanya KELELAHAN yang diuji backtest (scripts/backtest.ts bagian I). Sisanya memakai efek kecil & konservatif yang
 * BELUM tervalidasi karena data historisnya tidak ada di repo; semuanya bisa dimatikan lewat env (lihat CFG.ctx*). */

// ---------------------------------------------------------------- Final
/** "Final" tunggal (bukan "Semi-finals", bukan "Quarter-finals"). Perebutan tempat ketiga tidak dihitung. */
export const isFinalRound = (round?: string | null) => /^\s*(the\s+)?finals?\s*$/i.test(String(round ?? ''));

// ---------------------------------------------------------------- Derbi
/** Pasangan derbi/rivalitas besar. Nama dicocokkan PERSIS setelah dinormalisasi (lihat tokens() di standings.ts), alternatif dipisah '|'.
 *  Sengaja hanya pasangan yang sangat jelas; tambah sendiri bila perlu. */
const DERBIES: [string, string][] = [
  // Inggris
  ['manchester united', 'manchester city'], ['liverpool', 'everton'], ['arsenal', 'tottenham|tottenham hotspur'], ['arsenal', 'chelsea'], ['chelsea', 'tottenham|tottenham hotspur'],
  ['liverpool', 'manchester united'], ['newcastle|newcastle united', 'sunderland'], ['aston villa', 'birmingham|birmingham city'], ['west ham|west ham united', 'millwall'], ['west ham|west ham united', 'tottenham|tottenham hotspur'],
  // Spanyol
  ['real madrid', 'barcelona'], ['real madrid', 'atletico madrid'], ['barcelona', 'espanyol'], ['sevilla', 'real betis|betis'], ['athletic club|athletic bilbao', 'real sociedad'], ['valencia', 'levante'],
  // Italia
  ['milan|ac milan', 'inter|inter milan|internazionale'], ['roma|as roma', 'lazio'], ['juventus', 'torino'], ['inter|inter milan|internazionale', 'juventus'], ['napoli', 'roma|as roma'], ['genoa', 'sampdoria'],
  // Jerman
  ['borussia dortmund|dortmund', 'schalke 04|schalke'], ['bayern munich|bayern munchen|bayern', 'borussia dortmund|dortmund'], ['hamburger|hamburg|hamburger sv', 'st pauli|st pauli'], ['koln|1 koln|cologne', 'borussia monchengladbach|monchengladbach'], ['eintracht frankfurt', 'mainz 05|mainz'],
  // Prancis
  ['paris saint germain|paris saint-germain|psg', 'marseille|olympique marseille'], ['lyon|olympique lyonnais', 'saint etienne|saint-etienne'], ['lyon|olympique lyonnais', 'marseille|olympique marseille'], ['nice', 'monaco'],
  // Belanda & Portugal & Skotlandia & Turki
  ['ajax', 'feyenoord'], ['ajax', 'psv|psv eindhoven'], ['psv|psv eindhoven', 'feyenoord'], ['benfica', 'sporting|sporting cp|sporting lisbon'], ['benfica', 'porto|fc porto'], ['porto|fc porto', 'sporting|sporting cp|sporting lisbon'],
  ['celtic', 'rangers'], ['galatasaray', 'fenerbahce'], ['galatasaray', 'besiktas'], ['fenerbahce', 'besiktas'],
  // Amerika Latin
  ['boca juniors', 'river plate'], ['flamengo|flamengo rj', 'fluminense|fluminense rj'], ['flamengo|flamengo rj', 'vasco da gama|vasco'], ['corinthians', 'palmeiras'], ['corinthians', 'sao paulo'], ['palmeiras', 'sao paulo'],
  ['gremio', 'internacional'], ['atletico mineiro|atletico mg', 'cruzeiro'], ['racing club', 'independiente'], ['penarol', 'nacional'], ['america de cali', 'deportivo cali'],
  // Asia
  ['al hilal|al-hilal', 'al nassr|al-nassr'], ['al ittihad|al-ittihad', 'al ahli|al-ahli|al ahli jeddah'], ['al hilal|al-hilal', 'al ittihad|al-ittihad'], ['persija|persija jakarta', 'persib|persib bandung'], ['arema|arema fc', 'persebaya|persebaya surabaya'],
  ['urawa|urawa red diamonds|urawa reds', 'gamba osaka'], ['fc seoul', 'suwon|suwon bluewings|suwon samsung bluewings'], ['la galaxy', 'los angeles fc|lafc'],
];
const norm = (s: string) => tokens(s).join(' ');
const specs = DERBIES.map(([a, b]) => [a.split('|').map(norm), b.split('|').map(norm)] as [string[], string[]]);
export function isDerby(home: string, away: string): boolean {
  const h = norm(home), a = norm(away); if (!h || !a || h === a) return false;
  return specs.some(([x, y]) => (x.includes(h) && y.includes(a)) || (x.includes(a) && y.includes(h)));
}

// ---------------------------------------------------------------- Kelelahan (jeda antar-laga)
/** Skor kelelahan 0..1 dari jeda hari sejak laga terakhir + jumlah laga dalam 10 hari terakhir.
 *  Jeda <= 2 hari = 1, 3 hari ~ 0,6, >= 4,5 hari = 0. Tiap laga ke-3+ dalam 10 hari menambah 0,25 (padat jadwal). Tidak diketahui -> null (tanpa penyesuaian). */
export function fatigueScore(restDays: number | null | undefined, gamesIn10d = 0): number | null {
  if (restDays === null || restDays === undefined || !Number.isFinite(restDays) || restDays <= 0) return null;
  const s = Math.min(1, Math.max(0, (4.5 - restDays) / 2.5));
  return Math.min(1, s + (gamesIn10d >= 3 ? 0.25 : 0));
}
/** Dari daftar timestamp (detik) laga lampau sebuah tim, hitung jeda hari & jumlah laga 10 hari sebelum `ts`. */
export function restInfo(recent: number[] | undefined, ts: number): { rest: number | null; n10: number } {
  const past = (recent ?? []).filter(t => t < ts - 3600 * 6).sort((a, b) => b - a);
  return { rest: past.length ? (ts - past[0]) / 86400 : null, n10: past.filter(t => ts - t <= 10 * 86400).length };
}
/** Pengali xG (kandang, tandang) akibat selisih kelelahan. Butuh KEDUA tim punya data jeda; bila salah satu tidak ada -> tanpa efek. */
export function fatigueMultipliers(fH: number | null, fA: number | null, rel: number): [number, number] {
  if (fH === null || fA === null || !rel) return [1, 1];
  const d = fH - fA; return [Math.exp(-rel * d), Math.exp(rel * d)];
}

// ---------------------------------------------------------------- Leg kedua
export interface Leg { h: number; a: number; hg: number; ag: number; ts: number }
export const isKnockoutRound = (round?: string | null) => /final|round of|play-?off|knockout|preliminary|qualifying round|last \d+|1\/\d+|eliminat|tie/i.test(String(round ?? '')) && !/regular season|group|league (stage|phase)/i.test(String(round ?? ''));
export const legKey = (leagueId: number, season: number, round: string, a: number, b: number) => `${leagueId}:${season}:${round}:${Math.min(a, b)}-${Math.max(a, b)}`;
/** Agregat untuk tim kandang di leg kedua = (gol timnya di leg 1) - (gol lawan di leg 1). Null bila ini bukan leg kedua atau leg 1 tidak tercatat. */
export function aggregateBeforeLeg2(leg1: Leg | undefined, homeId: number, awayId: number, ts: number): number | null {
  if (!leg1 || leg1.h !== awayId || leg1.a !== homeId || leg1.ts >= ts) return null; // leg 1 = tim tandang kini menjadi tuan rumah
  return leg1.ag - leg1.hg;
}
/** Pengali xG (kandang, tandang): tim yang tertinggal agregat menyerang lebih banyak, tim yang unggul bertahan. Dibatasi +-2 gol. */
export function leg2Multipliers(aggHome: number, k: number): [number, number] {
  const t = Math.max(-2, Math.min(2, aggHome)); return [Math.exp(-k * t), Math.exp(k * t)];
}

// ---------------------------------------------------------------- Grup timnas
export interface GTeam { id: number; pts: number; p: number }
export interface GroupTable { name: string; teams: GTeam[]; sure: number; maybe: number; G: number }
/** Ubah respons API-Football standings (array grup) menjadi tabel per grup.
 *  sure  = slot lolos langsung (deskripsi memuat promotion/qualification/next round...), maybe = sure + slot playoff/peringkat-ketiga terbaik.
 *  Tanpa deskripsi -> pakai CFG.groupSlots[leagueId] (default 2). G = laga per tim se-grup (CFG.groupRounds; tidak diketahui -> kandang-tandang = konservatif). */
export function parseGroups(leagueId: number, standings: any[][]): GroupTable[] {
  const out: GroupTable[] = [];
  for (const g of standings ?? []) {
    const rows = (g ?? []).filter((r: any) => r?.team?.id && typeof r.points === 'number'); if (rows.length < 3) continue;
    const N = rows.length, desc = (r: any) => String(r.description ?? '');
    const sure = rows.filter(r => /promotion|qualif|next round|round of|knockout|advance/i.test(desc(r)) && !/play-?off|third|best/i.test(desc(r))).length;
    const wild = rows.filter(r => /play-?off|third|best|repechage/i.test(desc(r))).length;
    const fallback = CFG.groupSlots[leagueId] ?? 2, hasDesc = sure + wild > 0;
    const rounds = CFG.groupRounds[leagueId] ?? 2;
    out.push({ name: String(rows[0].group ?? ''), teams: rows.map((r: any) => ({ id: r.team.id, pts: r.points, p: r.all?.played ?? 0 })), sure: hasDesc ? sure : fallback, maybe: hasDesc ? sure + wild : fallback, G: rounds * (N - 1) });
  }
  return out;
}
export const findGroup = (groups: GroupTable[], a: number, b: number) => groups.find(g => g.teams.some(t => t.id === a) && g.teams.some(t => t.id === b));

/** Status matematis satu tim di grupnya (konservatif: seri poin dianggap belum pasti):
 *  through = pasti lolos (paling banyak sure-1 tim lain yang masih bisa menyamai/melewati poinnya)
 *  out     = pasti gugur (sedikitnya `maybe` tim lain sudah punya poin lebih tinggi dari poin maksimumnya)
 *  alive   = masih berebut. */
export function groupState(g: GroupTable, teamId: number): GroupState {
  const me = g.teams.find(t => t.id === teamId)!, max = me.pts + 3 * Math.max(0, g.G - me.p), others = g.teams.filter(t => t.id !== teamId);
  const canReach = others.filter(t => t.pts + 3 * Math.max(0, g.G - t.p) >= me.pts).length; // lawan yang masih bisa menyamai poin saya sekarang
  if (g.sure > 0 && canReach <= g.sure - 1) return 'through';
  const above = others.filter(t => t.pts > max).length;
  if (g.maybe > 0 && above >= g.maybe) return 'out';
  return 'alive';
}
const STATE_NEED: Record<GroupState, number> = { alive: 1, through: 0.4, out: 0.15 };
const STATE_LABEL: Record<GroupState, string> = { alive: 'Berebut lolos', through: 'Sudah lolos', out: 'Sudah gugur' };

// ---------------------------------------------------------------- Sinyal AI (v6, lihat scripts/aiContext.ts)
export interface AiKnown { home: boolean; away: boolean }
export interface AiTeamEffect { w: number; conf: boolean; parts: string[]; ev: string[] }
const AI_PART: Record<string, string> = { heavy: 'rotasi besar', some: 'rotasi sebagian', low: 'motivasi rendah', champion: 'sudah juara', relegated: 'sudah degradasi', qualified: 'sudah lolos', eliminated: 'sudah gugur', tired: 'kelelahan' };
/** Bobot penurunan xG (ln) satu tim dari sinyal AI, dibatasi CFG.ctxAiMaxXg lalu dikali CFG.ctxAiScale. Bila sistem sudah menilai motivasi tim itu
 *  (tabel/grup: `known`), sinyal motivasi/status AI diabaikan (tidak dihitung dua kali) dan rotasi dihitung setengah. Efek selalu MENURUNKAN xG tim itu (tidak pernah menaikkan). */
export function aiTeamEffect(ai: AiCtx | undefined, team: 'home' | 'away', known: boolean, cfg = CFG): AiTeamEffect {
  const eff: AiTeamEffect = { w: 0, conf: false, parts: [], ev: [] };
  for (const s of ai?.sigs ?? []) {
    if (s.team !== team) continue;
    const add = (w: number, label: string) => { eff.w += w; eff.parts.push(label); eff.ev.push(`${s.ev}${s.hosts.length ? ` (${s.hosts.join(', ')})` : ''}`); };
    if (s.kind === 'rotation') { add((s.value === 'heavy' ? cfg.ctxAiRotHeavy : cfg.ctxAiRotSome) * (known ? 0.5 : 1), AI_PART[s.value]); if (s.value === 'heavy') eff.conf = true; }
    else if (s.kind === 'fatigue') add(cfg.ctxAiTired, AI_PART.tired);
    else if (!known) { add(cfg.ctxAiLowMotive, AI_PART[s.kind === 'status' ? s.value : 'low']); eff.conf = true; }
  }
  eff.w = Math.min(eff.w, cfg.ctxAiMaxXg) * cfg.ctxAiScale;
  return eff;
}

// ---------------------------------------------------------------- Rakit konteks
export interface CtxInput {
  leagueId: number; season: number; round?: string | null; ts: number;
  home: { id: number; name: string; recent?: number[] }; away: { id: number; name: string; recent?: number[] };
  leg1?: Leg; group?: GroupTable;
  /** v6: sinyal AI (sudah tervalidasi) dan penanda tim yang motivasinya sudah dinilai tabel liga */
  ai?: AiCtx; tableKnown?: AiKnown;
}
export const CTX_OFF = { final: false, derby: false, leg2: false, fatigue: false, group: false };
/** Hitung tag, pengali xG, dan faktor keyakinan. Semua sakelar di CFG.ctx*. Mengembalikan null bila tidak ada satu pun konteks yang relevan. */
export function buildContext(x: CtxInput, cfg = CFG): MatchContext | null {
  const tags: CtxTag[] = []; let mh = 1, ma = 1, conf = 1; const info: MatchContext['info'] = {};
  const push = (kind: CtxTag['kind'], label: string, title?: string) => tags.push({ kind, label, title });

  if (cfg.ctxFinal && isFinalRound(x.round)) {
    const f = Math.exp(-cfg.ctxFinalGoals); mh *= f; ma *= f; conf *= cfg.ctxFinalConf;
    push('final', '🏆 Final', 'Laga final: pemain dan pelatih cenderung lebih hati-hati (total gol sedikit lebih rendah) dan hasilnya lebih sulit ditebak, sehingga keyakinan dipotong.');
  }
  if (cfg.ctxDerby && isDerby(x.home.name, x.away.name)) {
    conf *= cfg.ctxDerbyConf;
    push('derby', '🔥 Derbi', 'Derbi/rivalitas besar: bentuk tim kurang menentukan, keyakinan dipotong sedikit. xG tidak diubah.');
  }
  if (cfg.ctxLeg2) {
    let agg = aggregateBeforeLeg2(x.leg1, x.home.id, x.away.id, x.ts), k = cfg.ctxLeg2K, viaAi = false, aiEv = '';
    if (agg === null && cfg.ctxAi && x.ai?.leg1 && isKnockoutRound(x.round) && !isFinalRound(x.round)) { // leg 1 belum tercatat sistem -> pakai skor dari berita (tervalidasi), dipercaya sebagian
      agg = x.ai.leg1.hg - x.ai.leg1.ag; k = cfg.ctxLeg2K * cfg.ctxAiLegTrust * (cfg.ctxAiScale > 0 ? 1 : 0); viaAi = true; aiEv = `${x.ai.leg1.ev} (${x.ai.leg1.host})`;
    }
    if (agg !== null) {
      const [a, b] = leg2Multipliers(agg, k); mh *= a; ma *= b; info.aggHome = agg; info.aggSrc = viaAi ? 'ai' : 'own';
      const lead = agg === 0 ? 'imbang' : agg > 0 ? `${x.home.name} unggul ${agg}` : `${x.away.name} unggul ${-agg}`;
      const t: CtxTag = { kind: 'leg2', label: `↩️ Leg 2 · agregat ${lead}${viaAi ? ' · AI' : ''}`, title: 'Leg kedua: tim yang tertinggal agregat menyerang lebih banyak, tim yang unggul bertahan. Dampak kecil pada xG.' + (viaAi ? ` Skor leg 1 dibaca AI dari berita web (belum tercatat sistem): "${aiEv}"` : '') };
      if (viaAi) t.ai = true; tags.push(t);
    }
  }
  if (cfg.ctxGroup && x.group) {
    const sH = groupState(x.group, x.home.id), sA = groupState(x.group, x.away.id);
    info.group = { home: sH, away: sA, name: x.group.name };
    if (sH !== 'alive' || sA !== 'alive' || x.group.teams.some(t => t.p >= x.group!.G - 1)) { // hanya ditampilkan bila ada yang sudah pasti, atau menjelang akhir fase grup
      const d = (STATE_NEED[sH] - STATE_NEED[sA]) / 2, r = cfg.ctxGroupRel; mh *= Math.exp(r * d); ma *= Math.exp(-r * d);
      push('group', `🎯 ${x.home.name}: ${STATE_LABEL[sH]} · ${x.away.name}: ${STATE_LABEL[sA]}`, 'Klasemen grup: tim yang sudah lolos/gugur dianggap kurang termotivasi (rotasi), lawan yang masih berebut dinilai lebih tajam. Perhitungan matematis konservatif (seri poin dianggap belum pasti).');
      if ((sH === 'through' && sA === 'through') || (sH === 'out' && sA === 'out')) conf *= cfg.ctxDeadConf; // dua-duanya tanpa taruhan: rotasi acak
    }
  }
  if (cfg.ctxFatigue) {
    const H = restInfo(x.home.recent, x.ts), A = restInfo(x.away.recent, x.ts), fH = fatigueScore(H.rest, H.n10), fA = fatigueScore(A.rest, A.n10);
    if (fH !== null && fA !== null) {
      const [a, b] = fatigueMultipliers(fH, fA, cfg.ctxFatigueRel); info.rest = { home: Math.round(H.rest! * 10) / 10, away: Math.round(A.rest! * 10) / 10 };
      mh *= a; ma *= b;
      if (Math.abs(fH - fA) >= 0.4) { const tired = fH > fA ? x.home.name : x.away.name, days = fH > fA ? H.rest! : A.rest!; push('fatigue', `😮‍💨 ${tired}: jeda ${days.toFixed(1)} hari`, cfg.ctxFatigueRel > 0 ? 'Jadwal padat: tim dengan jeda antar-laga pendek dinilai sedikit lebih lemah.' : 'Jadwal padat: informasi saja. Backtest 27 ribu laga klub tidak menemukan pengaruh jeda antar-laga yang nyata, jadi xG tidak diubah.'); }
    }
  }
  // --- v6: sinyal AI (derbi yang belum ada di daftar, rotasi, motivasi, status, kelelahan). Hanya bila CFG.ctxAi; semua sudah divalidasi aiContext.ts ---
  if (cfg.ctxAi && x.ai) {
    if (cfg.ctxDerby && x.ai.derby && !isDerby(x.home.name, x.away.name)) {
      if (cfg.ctxAiScale > 0) conf *= cfg.ctxDerbyConf;
      tags.push({ kind: 'derby', ai: true, label: '🔥 Derbi · AI', title: `Derbi/rivalitas menurut berita web (tidak ada di daftar sistem): "${x.ai.derby.ev}" (${x.ai.derby.host}). Keyakinan dipotong sedikit.` });
    }
    const kn = { home: !!x.group || !!x.tableKnown?.home, away: !!x.group || !!x.tableKnown?.away }, sides = ['home', 'away'] as const;
    const eff = { home: aiTeamEffect(x.ai, 'home', kn.home, cfg), away: aiTeamEffect(x.ai, 'away', kn.away, cfg) };
    let nConf = 0;
    for (const s of sides) {
      const e = eff[s]; if (!e.parts.length) continue;
      const name = s === 'home' ? x.home.name : x.away.name;
      if (e.conf && cfg.ctxAiScale > 0) nConf++;
      tags.push({ kind: 'ai', ai: true, label: `🤖 ${name}: ${[...new Set(e.parts)].join(', ')}`, title: `Dibaca AI dari berita web (belum terverifikasi resmi). Bukti: ${e.ev.join(' | ')}. ${cfg.ctxAiScale > 0 ? `Dampak xG ${(-(1 - Math.exp(-e.w)) * 100).toFixed(1)}% (dibatasi ${(cfg.ctxAiMaxXg * 100).toFixed(0)}%).` : 'Hanya label, xG tidak diubah.'}` });
    }
    mh *= Math.exp(-eff.home.w); ma *= Math.exp(-eff.away.w);
    if (nConf) conf *= Math.max(cfg.ctxAiConfMin, 1 - cfg.ctxAiConfStep * nConf);
    const nSig = x.ai.sigs.length + (x.ai.leg1 ? 1 : 0) + (x.ai.derby ? 1 : 0);
    if (nSig > 0) info.ai = { nSrc: x.ai.nSrc, signals: nSig, xg: { home: Math.round((Math.exp(-eff.home.w) - 1) * 1000) / 1000, away: Math.round((Math.exp(-eff.away.w) - 1) * 1000) / 1000 } };
  }
  if (!tags.length) return null;
  mh = Math.min(1.25, Math.max(0.8, mh)); ma = Math.min(1.25, Math.max(0.8, ma)); // pengaman gabungan semua efek konteks
  return { tags, mul: { home: mh, away: ma }, confFactor: conf, info };
}
