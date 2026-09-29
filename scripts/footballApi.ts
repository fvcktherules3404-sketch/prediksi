import { CFG } from './config.ts';
import { ApiUsage } from './apiUsage.ts';
import { readCache, writeCache } from './cache.ts';

export type Src = 'live' | 'cache' | 'stale';
/** Wrapper API-Football: cache di memori + file, hitung kuota, fallback ke cache lama. Ganti provider cukup di file ini. */
export class FootballApi {
  private mem = new Map<string, any[]>();
  private key: string; private usage: ApiUsage;
  constructor(key: string, usage: ApiUsage) { this.key = key; this.usage = usage; }

  /** persist=false: hanya cache memori (untuk respons besar/sekali pakai, mis. odds & hasil kemarin) -> repo tidak membengkak dan tidak ada risiko cache basi. */
  async get(endpoint: string, params: Record<string, string | number>, ttlH: number, persist = true): Promise<{ data: any[]; source: Src } | null> {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    const ck = `${endpoint}_${qs}`;
    if (this.mem.has(ck)) return { data: this.mem.get(ck)!, source: 'cache' };
    const c = persist ? readCache<any[]>(CFG.cacheDir, ck) : null;
    const ageH = c ? (Date.now() - c.ts) / 3.6e6 : Infinity;
    if (c && ageH <= ttlH) { this.mem.set(ck, c.data); return { data: c.data, source: 'cache' }; }

    const stale = () => (c && ageH <= CFG.maxStaleH ? { data: c.data, source: 'stale' as Src } : null);
    if (!this.usage.canRequest()) { console.warn(`[quota] batas request tercapai, lewati ${ck}`); return stale(); }
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
      const res = await fetch(`${CFG.footballBase}/${endpoint}?${qs}`, { headers: { 'x-apisports-key': this.key }, signal: ctl.signal });
      clearTimeout(t);
      this.usage.record(res.headers.get('x-ratelimit-requests-remaining'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: any = await res.json();
      const e = json.errors;
      if (e && (Array.isArray(e) ? e.length : Object.keys(e).length)) throw new Error(JSON.stringify(e));
      const data = json.response ?? [];
      if (persist) writeCache(CFG.cacheDir, ck, data);
      this.mem.set(ck, data);
      return { data, source: 'live' };
    } catch (err) {
      console.warn(`[football] gagal ${ck}: ${(err as Error).message}`);
      return stale();
    }
  }
}
