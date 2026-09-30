import fs from 'node:fs';
import path from 'node:path';
import { CFG } from './config.ts';
import { readCache, writeCache } from './cache.ts';
import { keyId } from './apiUsage.ts';

/** Pencarian web via Tavily (paket gratis: 1.000 kredit/bulan PER KEY, tanpa kartu). Gemini TIDAK lagi memakai Google Search grounding;
 *  hasil pencarian di sini ditempel ke prompt Gemini sebagai SUMBER. 1 pencarian 'basic' = 1 kredit.
 *  Multi-key seperti API-Football: key dipakai berurutan, pindah otomatis bila kuota bulanan sebuah key habis. */
export type WebHit = { title: string; url: string; content: string };

const ENDPOINT = 'https://api.tavily.com/search';

/** Kumpulkan API key Tavily dari env, urutan = prioritas (duplikat & kosong dibuang):
 *  TAVILY_API_KEY, TAVILY_API_KEY_2 .. _5, dan TAVILY_API_KEYS (dipisah koma). */
export function readTavilyKeys(env: Record<string, string | undefined> = process.env): string[] {
  const raw = [env.TAVILY_API_KEY, ...[2, 3, 4, 5].map(n => env[`TAVILY_API_KEY_${n}`]), env.TAVILY_API_KEYS].filter(Boolean).join(',');
  return [...new Set(raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean))];
}

const MONTH_LIMIT = Number(process.env.TAVILY_MONTHLY_LIMIT ?? 1000); // kredit per key per bulan (paket Free)
const RESERVE = 10;                                                    // sisakan sedikit sebagai pengaman
/** Batas pencarian per run. Default 15 per key: 15 x 2 run/hari x 30 hari = 900 < 1.000 per key. Bisa diubah lewat TAVILY_MAX_PER_RUN. */
const maxPerRun = (nKeys: number) => Number(process.env.TAVILY_MAX_PER_RUN ?? 15 * Math.max(1, nKeys));
let used = 0;
const badThisRun = new Set<string>(); // key ditolak (401/403): dilewati di run ini saja, TIDAK disimpan ke file (supaya salah tempel tidak mengunci sebulan)

interface KeyState { used: number; exhausted?: boolean }
interface UsageState { month: string; keys: Record<string, KeyState> }
const usageFile = () => path.join(CFG.cacheDir, 'tavily_usage.json');
/** Status pemakaian per key, reset tiap awal bulan (UTC) mengikuti Tavily. Dibaca ulang tiap panggilan (file kecil). */
function loadUsage(): UsageState {
  const month = new Date().toISOString().slice(0, 7);
  try { const o = JSON.parse(fs.readFileSync(usageFile(), 'utf8')); if (o?.month === month && o.keys && typeof o.keys === 'object') return { month, keys: o.keys }; } catch {}
  return { month, keys: {} };
}
function saveUsage(s: UsageState) { try { fs.mkdirSync(path.dirname(usageFile()), { recursive: true }); fs.writeFileSync(usageFile(), JSON.stringify(s)); } catch {} }
const usable = (s: UsageState, id: string) => !badThisRun.has(id) && !s.keys[id]?.exhausted && (s.keys[id]?.used ?? 0) < MONTH_LIMIT - RESERVE;
/** Batas kuota Tavily: HTTP 432 (plan) / 433 (pay-as-you-go), atau pesan "usage limit" pada respons non-OK. HTTP 429 biasa = rate limit sementara, BUKAN kuota habis. */
const isQuota = (status: number, text: string) => status === 432 || status === 433 || /usage limit|exceeds (your|the) plan/i.test(text);

export const hasSearch = () => readTavilyKeys().length > 0;
export const searchesUsed = () => used;
/** Ringkasan untuk log: pencarian run ini dan pemakaian bulan ini per key (urutan sama dengan daftar key; key asli tidak ditampilkan). */
export function tavilySummary(): string {
  const keys = readTavilyKeys(), s = loadUsage();
  return `run ${used}/${maxPerRun(keys.length)} · bulan ${s.month}: ` + keys.map((k, i) => { const st = s.keys[keyId(k)]; return `key${i + 1} ${st?.used ?? 0}/${MONTH_LIMIT}${st?.exhausted ? ' HABIS' : ''}`; }).join(', ');
}

export async function webSearch(query: string, opts: { news?: boolean; days?: number; max?: number; raw?: boolean } = {}): Promise<WebHit[]> {
  const keys = new Map(readTavilyKeys().map(k => [keyId(k), k] as const));
  if (!keys.size) throw new Error('TAVILY_API_KEY kosong');
  const cap = maxPerRun(keys.size);
  if (used >= cap) throw new Error(`HTTP 429 (tavily-budget): batas ${cap} pencarian per run tercapai`);
  used++;
  const body: Record<string, unknown> = { query, search_depth: 'basic', max_results: opts.max ?? 5, include_answer: false };
  if (opts.news) { body.topic = 'news'; body.days = opts.days ?? 7; }
  if (opts.raw) body.include_raw_content = 'text';
  for (let tries = 0; tries < keys.size; tries++) { // sekali per key
    const st = loadUsage(), id = [...keys.keys()].find(k => usable(st, k));
    if (!id) throw new Error(`HTTP 432 (tavily): semua key (${keys.size}) habis untuk bulan ${st.month}`);
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keys.get(id)!}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      if (isQuota(res.status, text)) { (st.keys[id] ??= { used: 0 }).exhausted = true; saveUsage(st); console.warn(`[tavily] key ${id} kuota bulanan habis (HTTP ${res.status}), pindah key`); continue; }
      if (res.status === 401 || res.status === 403) { badThisRun.add(id); console.warn(`[tavily] key ${id} ditolak (HTTP ${res.status}), dilewati di run ini`); continue; }
      throw new Error(`HTTP ${res.status} (tavily): ${text}`);
    }
    (st.keys[id] ??= { used: 0 }).used++; saveUsage(st); // hanya respons sukses yang memakai kredit
    const j: any = await res.json();
    return (Array.isArray(j.results) ? j.results : [])
      .map((r: any): WebHit => ({
        title: String(r?.title ?? '').slice(0, 120),
        url: String(r?.url ?? ''),
        content: String((opts.raw ? r?.raw_content : null) ?? r?.content ?? ''),
      }))
      .filter((h: WebHit) => h.url && h.content.trim());
  }
  throw new Error(`HTTP 401 (tavily): semua key ditolak/habis`);
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