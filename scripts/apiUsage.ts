import fs from 'node:fs';
import path from 'node:path';

/** Menghitung estimasi request harian (reset 00:00 UTC, mengikuti API-Football). Disimpan di file agar run manual ikut terhitung. */
export class ApiUsage {
  private state: { date: string; used: number; remaining?: number };
  private file: string; readonly limit: number; private reserve: number;
  constructor(file: string, limit: number, reserve: number) {
    this.file = file; this.limit = limit; this.reserve = reserve;
    const today = new Date().toISOString().slice(0, 10);
    let s = { date: today, used: 0 } as { date: string; used: number; remaining?: number };
    try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); if (o.date === today) s = o; } catch {}
    this.state = s;
  }
  get used() { return this.state.used; }
  canRequest(): boolean {
    if (this.state.used >= this.limit - this.reserve) return false;
    if (this.state.remaining !== undefined && this.state.remaining <= this.reserve) return false;
    return true;
  }
  record(remainingHeader?: string | null) {
    this.state.used++;
    const r = Number(remainingHeader);
    if (remainingHeader != null && remainingHeader !== '' && Number.isFinite(r)) this.state.remaining = r;
    this.save();
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state));
  }
}
