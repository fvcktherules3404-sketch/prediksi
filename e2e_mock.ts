/** (Nama berkas sengaja TIDAK berakhiran "run.ts": run.ts otomatis berjalan bila argv[1] berakhiran "run.ts".)
 *  Uji end-to-end run.ts penuh TANPA jaringan: API-Football, Tavily, dan Gemini semuanya palsu (fetch di-mock).
 *  Cara pakai: salin proyek ke folder lain (skrip ini MENULIS ke data/ dan public/data/), lalu di root proyek: `npx tsx e2e_mock.ts`
 *  Yang diuji: konteks sistem (final, derbi, leg 2, grup timnas, jeda) + konteks AI v6 (rotasi, kelelahan, skor leg 1, karangan yang harus ditolak, cache). */
import fs from 'node:fs';
process.env.FOOTBALL_API_KEY = 'x'; process.env.GEMINI_API_KEY = 'g'; process.env.TAVILY_API_KEY = 't';
for (const k of ['USE_ODDS', 'USE_INJURIES', 'AI_OPINION', 'USE_ELO', 'GEMINI_STANDINGS']) process.env[k] = 'false';
fs.rmSync('data/cache', { recursive: true, force: true });
// jam palsu: 11:00 WIB (sesi pagi) supaya hasil kemarin ikut dikumpulkan berapa pun jam sebenarnya
const realNow = Date.now.bind(Date), t0 = realNow(), fake = Date.UTC(2026, 8, 30, 4, 0, 0); Date.now = () => fake + (realNow() - t0);
const { computeWindow } = await import('./scripts/run.ts');
const w = computeWindow(Date.now()), S = 1000, DAYS = 86400;
const ts = (h: number) => Math.floor((w.start + h * 3600e3) / S);
const yest = Math.floor(w.start / S) - 20 * 3600;
const fx = (id: number, lg: number, round: string, h: [number, string], a: [number, string], t: number, st = 'NS', g: [number, number] | null = null, name = 'Test Cup', season = 2026) => ({
  fixture: { id, timestamp: t, date: new Date(t * 1000).toISOString(), status: { short: st } }, league: { id: lg, name, country: 'World', season, round },
  teams: { home: { id: h[0], name: h[1] }, away: { id: a[0], name: a[1] } }, goals: g ? { home: g[0], away: g[1] } : { home: null, away: null }, score: { fulltime: g ? { home: g[0], away: g[1] } : {} } });
const finished = [
  fx(9001, 2, 'Round of 16', [300, 'Feyenoord'], [301, 'Ajax'], yest, 'FT', [3, 1], 'Champions League'),   // leg 1 yang tercatat sistem
  fx(9002, 2, 'Semi-finals', [200, 'Inter'], [201, 'AC Milan'], yest, 'FT', [2, 1], 'Champions League'),
  fx(9003, 2, 'Semi-finals', [202, 'Foo'], [203, 'Bar'], yest, 'FT', [0, 1], 'Champions League'),
  fx(9004, 1, 'Group Stage - 2', [1, 'Brazil'], [2, 'Serbia'], yest, 'FT', [2, 0], 'World Cup'),
  fx(9005, 1, 'Group Stage - 2', [3, 'Swiss'], [4, 'Cameroon'], yest, 'FT', [1, 0], 'World Cup'),
  fx(9006, 39, 'Regular Season - 8', [50, 'Tired FC'], [52, 'Other FC'], yest, 'FT', [1, 1], 'Premier League'),
  fx(9007, 39, 'Regular Season - 8', [51, 'Fresh FC'], [53, 'Third FC'], yest - 3 * DAYS, 'FT', [2, 2], 'Premier League'),
  fx(9008, 2, 'Round of 16', [400, 'Napoli'], [402, 'Zed FC'], yest, 'FT', [1, 0], 'Champions League'),      // Napoli & Porto: leg 1 NAPOLI-PORTO tidak tercatat sistem
  fx(9009, 2, 'Round of 16', [401, 'Porto'], [403, 'Yed FC'], yest, 'FT', [2, 1], 'Champions League'),
];
const today = [
  fx(8001, 2, 'Final', [200, 'Inter'], [201, 'AC Milan'], ts(2), 'NS', null, 'Champions League'),
  fx(8002, 2, 'Round of 16', [301, 'Ajax'], [300, 'Feyenoord'], ts(3), 'NS', null, 'Champions League'),
  fx(8003, 1, 'Group Stage - 3', [1, 'Brazil'], [4, 'Cameroon'], ts(4), 'NS', null, 'World Cup'),
  fx(8004, 39, 'Regular Season - 9', [50, 'Tired FC'], [51, 'Fresh FC'], ts(5), 'NS', null, 'Premier League'),
  fx(8005, 2, 'Round of 16', [400, 'Napoli'], [401, 'Porto'], ts(6), 'NS', null, 'Champions League'),
];
const grp = (id: number, pts: number, p: number) => ({ team: { id }, points: pts, group: 'Group A', all: { played: p }, description: null });
const standings = [[grp(1, 9, 3), grp(2, 4, 3), grp(3, 3, 3), grp(4, 0, 3)]];

// --- Tavily palsu: teks sumber per pertandingan (yang mengandung kata kunci nama tim) ---
const WEB: Record<string, [string, string][]> = {
  Inter: [['a.com', 'Inter played extra time in the semi-final and have had little recovery time before the final against Milan'], ['b.com', 'Milan and Inter meet in the final after a tiring extra time semi-final for Inter, who travelled back late']],
  Ajax: [['a.com', 'Ajax host Feyenoord in the second leg with the tie finely balanced after the first leg'], ['b.com', 'Feyenoord lead the tie and Ajax must attack in Amsterdam on Wednesday']],
  Brazil: [['a.com', 'Brazil coach says he will rotate heavily with several starters rested after securing qualification for the knockout round'], ['b.com', 'Brazil already qualified, reserves expected to start against Cameroon, the coach confirmed a rotation of the squad']],
  'Tired FC': [['a.com', 'Tired FC host Fresh FC in the league this weekend with both sides in mid table'], ['b.com', 'Fresh FC travel to Tired FC hoping to continue their recent form in the league']],
  Napoli: [['a.com', 'Porto beat Napoli 2-0 in the first leg at Estadio do Dragao and Napoli need a big comeback in the second leg'], ['b.com', 'Napoli must overturn a two goal deficit from the first leg against Porto at home']],
};
// --- Gemini palsu: jawaban per id (sebagian BENAR, sebagian karangan yang harus ditolak validator) ---
const ANSWERS: Record<number, any> = {
  8001: { sig: [{ team: 'home', kind: 'fatigue', value: 'tired', s: [1, 2], ev: 'Inter played extra time in the semi-final and have had little recovery time' }] },
  8002: { sig: [], leg1: { home_team: 'Feyenoord', score: '3-1', s: [1], ev: 'Feyenoord lead the tie and Ajax must attack in Amsterdam 3-1' } }, // sistem sudah punya leg 1 -> diabaikan
  8003: { sig: [{ team: 'home', kind: 'rotation', value: 'heavy', s: [1, 2], ev: 'he will rotate heavily with several starters rested after securing qualification' }, { team: 'home', kind: 'status', value: 'qualified', s: [2], ev: 'Brazil already qualified, reserves expected to start against Cameroon' }] },
  8004: { sig: [{ team: 'home', kind: 'status', value: 'champion', s: [1], ev: 'Tired FC have already been crowned champions of the league this season' }] },          // KARANGAN
  8005: { sig: [], leg1: { home_team: 'Porto', score: '2-0', s: [1], ev: 'Porto beat Napoli 2-0 in the first leg at Estadio do Dragao' } },
};
const calls: string[] = []; let newsCalls = 0, tavilyCalls = 0;
globalThis.fetch = (async (u: any, init: any) => {
  const url = new URL(String(u));
  if (url.hostname === 'api.tavily.com') {
    tavilyCalls++; const q: string = JSON.parse(init.body).query, k = Object.keys(WEB).find(x => q.includes(x));
    return new Response(JSON.stringify({ results: (k ? WEB[k] : []).map(([h, c], i) => ({ title: `Berita ${i + 1}`, url: `https://${h}/${i}`, content: c })) }));
  }
  if (url.hostname === 'generativelanguage.googleapis.com') {
    const prompt: string = JSON.parse(init.body).contents[0].parts[0].text;
    if (/ekstrak pemain yang cedera/.test(prompt)) { newsCalls++; const ids = [...prompt.matchAll(/### id (\d+):/g)].map(m => Number(m[1])); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(ids.map(id => ({ id, home: [], away: [], ctx: ANSWERS[id] ?? { sig: [] } }))) }] } }] })); }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '[]' }] } }] }));
  }
  calls.push(url.pathname.slice(1) + url.search);
  let response: any[] = [];
  if (url.pathname === '/fixtures') response = url.searchParams.get('status') ? finished : (url.searchParams.get('date') === w.dateA ? today : []);
  if (url.pathname === '/standings' && url.searchParams.get('league') === '1') response = [{ league: { standings } }];
  return new Response(JSON.stringify({ errors: [], response }), { headers: { 'x-ratelimit-requests-remaining': '90' } });
}) as any;
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/results.json', JSON.stringify({ version: 1, lastDate: null, seenIds: [], leagues: {}, scores: {}, recent: { '51': [ts(5) - 6 * DAYS], '50': [ts(5) - 5 * DAYS] }, legs: {} }));
process.env.FORCE_RUN = '1';
const show = () => {
  const out = JSON.parse(fs.readFileSync('public/data/predictions.json', 'utf8'));
  for (const m of out.matches) console.log(`\n#${m.id} ${m.home.name} vs ${m.away.name} [${m.league.round}] conf ${m.confidence} comp ${m.conf?.comp} xg ${m.xg.home}/${m.xg.away}\n  context: ${m.context ? JSON.stringify({ tags: m.context.tags.map((t: any) => (t.ai ? '[AI] ' : '') + t.label), mul: m.context.mul, cf: m.context.confFactor, agg: m.context.info.aggHome, aggSrc: m.context.info.aggSrc, ai: m.context.info.ai }) : 'none'}`);
  console.log('\nmetadata:', JSON.parse(fs.readFileSync('public/data/metadata.json', 'utf8')).message);
  console.log('aiContext:', JSON.stringify(JSON.parse(fs.readFileSync('public/data/metadata.json', 'utf8')).aiContext));
};
await import('./scripts/run.ts?run1'); await new Promise(r => setTimeout(r, 300));
console.log(`===== RUN 1 =====\npanggilan Gemini-berita: ${newsCalls}, Tavily: ${tavilyCalls}`); show();
const n1 = newsCalls, t1 = tavilyCalls;
await import('./scripts/run.ts?run2'); await new Promise(r => setTimeout(r, 300));
console.log(`\n===== RUN 2 (cache) =====\npanggilan Gemini-berita tambahan: ${newsCalls - n1}, Tavily tambahan: ${tavilyCalls - t1}`); show();
