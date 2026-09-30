import { CFG } from './config.ts';
import { ApiUsage, keyId } from './apiUsage.ts';
import { readCache, writeCache } from './cache.ts';

export type Src = 'live' | 'cache' | 'stale';

/** Kumpulkan API key API-Football dari env, urutan = prioritas (duplikat & kosong dibuang):
 *  FOOTBALL_API_KEY, FOOTBALL_API_KEY_2 .. _5, dan FOOTBALL_API_KEYS (dipisah koma). */
export function readApiKeys(env: Record<string, string | undefined> = process.env): string[] {
  const raw = [env.FOOTBALL_API_KEY, ...[2, 3, 4, 5].map(n => env[`FOOTBALL_API_KEY_${n}`]), env.FOOTBALL_API_KEYS].filter(Boolean).join(',');
  return [...new Set(raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean))];
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Batas HARIAN habis (bukan batas per menit, yang pesannya juga memuat kata "requests"). */
const isDailyQuota = (e: any) => /request limit|limit for the day|daily/i.test(JSON.stringify(e)) && !e?.rateLimit;
/** Key bermasalah (bukan soal kuota): akun di-suspend, key tidak dikenali/salah. Key ini dilewati, pindah ke key berikutnya. */
const isBadKey = (e: any) => /suspended|missing application key|invalid.*key|invalid.*token/i.test(JSON.stringify(e));
/** Jeda minimum antar request per key. Paket Free API-Football = 10 request/menit -> 6,5 dtk aman. Bisa diubah lewat env FOOTBALL_MIN_GAP_MS. */
const MIN_GAP_MS = Number(process.env.FOOTBALL_MIN_GAP_MS ?? 6500);
const isMinuteLimit = (e: any) => !!e?.rateLimit || /too many requests|per minute/i.test(JSON.stringify(e));

/** Wrapper API-Football: cache di memori + file, hitung kuota per key, pindah otomatis ke key berikutnya bila satu key habis,
 *  fallback ke cache lama. Ganti provider cukup di file ini. */
export class FootballApi {
  private mem = new Map<string, any[]>();
  private lastCall = new Map<string, number>();
  private keys = new Map<string, string>(); private usage: ApiUsage; private nKeys: number;
  constructor(keys: string | string[], usage: ApiUsage) {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) this.keys.set(keyId(k), k);
    this.nKeys = this.keys.size; this.usage = usage; usage.setKeys([...this.keys.keys()]);
  }

  /** persist=false: hanya cache memori (untuk respons besar/sekali pakai, mis. odds & hasil kemarin) -> repo tidak membengkak dan tidak ada risiko cache basi. */
  async get(endpoint: string, params: Record<string, string | number>, ttlH: number, persist = true): Promise<{ data: any[]; source: Src } | null> {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    const ck = `${endpoint}_${qs}`;
    if (this.mem.has(ck)) return { data: this.mem.get(ck)!, source: 'cache' };
    const c = persist ? readCache<any[]>(CFG.cacheDir, ck) : null;
    const ageH = c ? (Date.now() - c.ts) / 3.6e6 : Infinity;
    if (c && ageH <= ttlH) { this.mem.set(ck, c.data); return { data: c.data, source: 'cache' }; }

    const stale = () => (c && ageH <= CFG.maxStaleH ? { data: c.data, source: 'stale' as Src } : null);
    // Maks. percobaan: sekali per key (pindah key) + 3 kali menunggu batas per menit.
    for (let tries = 0, minuteWaits = 0; tries < this.nKeys + 3; tries++) {
      const id = this.usage.pick();
      if (!id) { console.warn(`[quota] semua key (${this.nKeys}) habis, lewati ${ck}`); return stale(); }
      try {
        const gap = MIN_GAP_MS - (Date.now() - (this.lastCall.get(id) ?? 0)); if (gap > 0) await sleep(gap); // cegah menabrak batas per menit
        this.lastCall.set(id, Date.now());
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
        const res = await fetch(`${CFG.footballBase}/${endpoint}?${qs}`, { headers: { 'x-apisports-key': this.keys.get(id)! }, signal: ctl.signal });
        clearTimeout(t);
        this.usage.record(id, res.headers.get('x-ratelimit-requests-remaining'));
        if (res.status === 429) { // bisa batas harian atau per menit; header sisa kuota menentukan
          const hdr = res.headers.get('x-ratelimit-requests-remaining'); // null = header tidak ada (JANGAN dianggap 0)
          const rem = hdr === null || hdr.trim() === '' ? NaN : Number(hdr);
          if (Number.isFinite(rem) && rem <= 0) { this.usage.exhaust(id); console.warn(`[quota] key ${id} habis (HTTP 429, sisa harian 0), pindah key`); continue; }
          if (minuteWaits++ < 3) { console.warn('[football] batas per menit (HTTP 429), tunggu 10 detik'); await sleep(10000); continue; }
          throw new Error('HTTP 429');
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: any = await res.json();
        const e = json.errors;
        if (e && (Array.isArray(e) ? e.length : Object.keys(e).length)) {
          if (isDailyQuota(e)) { this.usage.exhaust(id); console.warn(`[quota] key ${id} habis, pindah key`); continue; }
          if (isBadKey(e)) { this.usage.exhaust(id); console.warn(`[quota] key ${id} bermasalah (${JSON.stringify(e).slice(0, 80)}), pindah key`); continue; }
          if (isMinuteLimit(e) && minuteWaits++ < 3) { console.warn('[football] batas per menit, tunggu 10 detik lalu ulangi'); await sleep(10000); continue; }
          throw new Error(JSON.stringify(e));
        }
        const data = json.response ?? [];
        if (persist) writeCache(CFG.cacheDir, ck, data);
        this.mem.set(ck, data);
        return { data, source: 'live' };
      } catch (err) {
        console.warn(`[football] gagal ${ck}: ${(err as Error).message}`);
        return stale();
      }
    }
    return stale();
  }
}
