import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Id pendek (8 hex dari SHA-256) untuk mengenali sebuah API key di file usage.json tanpa menyimpan key aslinya. */
export const keyId = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 8);

interface KeyState { used: number; remaining?: number; exhausted?: boolean }
interface State { date: string; keys: Record<string, KeyState> }

/** Menghitung request harian PER API KEY (reset 00:00 UTC, mengikuti API-Football). Disimpan di file agar run manual ikut terhitung.
 *  Header sisa kuota dari API adalah sumber kebenaran; hitungan lokal dipakai hanya bila header belum pernah terbaca. */
export class ApiUsage {
  private state: State; private file: string; private perKeyLimit: number; private reserve: number;
  private ids: string[] = []; private legacy: KeyState | null = null;
  constructor(file: string, limit: number, reserve: number) {
    this.file = file; this.perKeyLimit = limit; this.reserve = reserve;
    const today = new Date().toISOString().slice(0, 10);
    let s: State = { date: today, keys: {} };
    try {
      const o = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (o.date === today) {
        if (o.keys && typeof o.keys === 'object') s = { date: today, keys: o.keys };
        else if (typeof o.used === 'number') this.legacy = { used: o.used, remaining: o.remaining }; // format lama (1 key)
      }
    } catch {}
    this.state = s;
  }
  /** Daftarkan key yang tersedia (urutan = prioritas: key pertama dipakai sampai habis, lalu pindah ke berikutnya). */
  setKeys(ids: string[]) {
    this.ids = ids;
    if (this.legacy && ids[0] && !this.state.keys[ids[0]]) this.state.keys[ids[0]] = this.legacy;
    this.legacy = null;
  }
  /** Total request terpakai dari semua key hari ini. */
  get used() { return this.ids.reduce((a, id) => a + (this.state.keys[id]?.used ?? 0), 0); }
  /** Total batas semua key. */
  get limit() { return this.perKeyLimit * Math.max(1, this.ids.length); }
  private usable(id: string): boolean {
    const st = this.state.keys[id];
    if (st?.exhausted) return false;
    if (st?.remaining !== undefined) return st.remaining > this.reserve;
    return (st?.used ?? 0) < this.perKeyLimit - this.reserve;
  }
  /** Key pertama yang masih punya kuota; null bila semua habis. */
  pick(): string | null { return this.ids.find(id => this.usable(id)) ?? null; }
  canRequest(): boolean { return this.pick() !== null; }
  record(id: string, remainingHeader?: string | null) {
    const st = (this.state.keys[id] ??= { used: 0 });
    st.used++;
    const r = Number(remainingHeader);
    if (remainingHeader != null && remainingHeader !== '' && Number.isFinite(r)) st.remaining = r;
    this.save();
  }
  /** Tandai key habis untuk hari ini (mis. API membalas batas harian tercapai). */
  exhaust(id: string) {
    const st = (this.state.keys[id] ??= { used: 0 });
    st.exhausted = true; st.remaining = 0; this.save();
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state));
  }
}
