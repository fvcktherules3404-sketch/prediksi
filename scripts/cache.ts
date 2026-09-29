import fs from 'node:fs';
import path from 'node:path';
const fileOf = (dir: string, key: string) => path.join(dir, key.replace(/[^a-z0-9_.-]/gi, '_') + '.json');
export function readCache<T>(dir: string, key: string): { ts: number; data: T } | null {
  try { return JSON.parse(fs.readFileSync(fileOf(dir, key), 'utf8')); } catch { return null; }
}
export function writeCache(dir: string, key: string, data: unknown) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fileOf(dir, key), JSON.stringify({ ts: Date.now(), data }));
}

/** Hapus file cache berumur > maxDays (berdasarkan field `ts` di dalam JSON, bukan mtime karena checkout git mengubah mtime). File tanpa `ts` (mis. usage.json) dibiarkan. */
export function pruneCache(dir: string, maxDays: number): number {
  let removed = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const file = path.join(dir, f);
      try {
        const o = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof o?.ts === 'number' && (Date.now() - o.ts) / 864e5 > maxDays) { fs.unlinkSync(file); removed++; }
      } catch { /* file rusak/bukan cache: biarkan */ }
    }
  } catch { /* folder belum ada */ }
  return removed;
}
