import { CFG } from './config.ts';
import { readCache, writeCache } from './cache.ts';

/** Pencarian web via Tavily (paket gratis: 1.000 kredit/bulan, tanpa kartu). Gemini TIDAK lagi memakai Google Search grounding;
 *  hasil pencarian di sini ditempel ke prompt Gemini sebagai SUMBER. 1 pencarian 'basic' = 1 kredit. */
export type WebHit = { title: string; url: string; content: string };

const ENDPOINT = 'https://api.tavily.com/search';
const MAX_PER_RUN = Number(process.env.TAVILY_MAX_PER_RUN ?? 30); // pengaman kuota: 30/hari x 30 hari = 900 < 1.000
let used = 0;

export const hasSearch = () => !!process.env.TAVILY_API_KEY;
export const searchesUsed = () => used;

export async function webSearch(query: string, opts: { news?: boolean; days?: number; max?: number; raw?: boolean } = {}): Promise<WebHit[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('TAVILY_API_KEY kosong');
  if (used >= MAX_PER_RUN) throw new Error(`HTTP 429 (tavily-budget): batas ${MAX_PER_RUN} pencarian per run tercapai`);
  used++;
  const body: Record<string, unknown> = { query, search_depth: 'basic', max_results: opts.max ?? 5, include_answer: false };
  if (opts.news) { body.topic = 'news'; body.days = opts.days ?? 7; }
  if (opts.raw) body.include_raw_content = 'text';
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} (tavily): ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const j: any = await res.json();
  return (Array.isArray(j.results) ? j.results : [])
    .map((r: any): WebHit => ({
      title: String(r?.title ?? '').slice(0, 120),
      url: String(r?.url ?? ''),
      content: String((opts.raw ? r?.raw_content : null) ?? r?.content ?? ''),
    }))
    .filter((h: WebHit) => h.url && h.content.trim());
}

/** Ubah hasil pencarian jadi blok teks bertanda [S1], [S2], ... untuk ditempel ke prompt. */
export function formatHits(hits: WebHit[], maxChars = 600): string {
  return hits.map((h, i) => `[S${i + 1}] ${h.title} (${new URL(h.url).hostname})\n${h.content.replace(/\s+/g, ' ').trim().slice(0, maxChars)}`).join('\n');
}

/** Cari berita satu pertandingan (cedera, skorsing, susunan, form, head-to-head). Di-cache per laga, dipakai bersama oleh
 *  modul berita dan opini AI supaya 1 laga hanya memakan 1 kredit. Hasil kosong juga di-cache agar tidak dicari ulang. */
export async function searchMatch(m: { id: number; home: string; away: string }): Promise<WebHit[]> {
  const ck = `web_match_${m.id}`, c = readCache<WebHit[]>(CFG.cacheDir, ck);
  if (c && (Date.now() - c.ts) / 3.6e6 <= CFG.newsTtlH) return c.data;
  const hits = await webSearch(`${m.home} vs ${m.away} preview team news injuries suspensions predicted lineup rotation first leg aggregate form`, { news: true, days: 7, max: 5 });
  writeCache(CFG.cacheDir, ck, hits);
  return hits;
}