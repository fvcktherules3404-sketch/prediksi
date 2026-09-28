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
