import { CFG } from './config.ts';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
let resolved: string | null = null;

/** Daftar model yang mendukung generateContent untuk API key ini. */
async function listModels(key: string): Promise<string[]> {
  try {
    const r = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    if (!r.ok) return [];
    const j: any = await r.json();
    return (j.models ?? []).filter((m: any) => m.supportedGenerationMethods?.includes('generateContent')).map((m: any) => String(m.name).replace(/^models\//, ''));
  } catch { return []; }
}

/** Pilih model Flash terbaru yang stabil. Urutan: alias -latest > versi tertinggi non-preview > preview > lite. */
export function pickModel(names: string[]): string | null {
  const bad = /(image|tts|live|audio|robotics|embedding|computer|native|learnlm|gemma|imagen|veo|exp)/;
  const flash = names.filter(n => /flash/.test(n) && !bad.test(n));
  if (!flash.length) return names.find(n => /gemini/.test(n) && !bad.test(n)) ?? null;
  if (flash.includes('gemini-flash-latest')) return 'gemini-flash-latest';
  const ver = (n: string) => Number(/gemini-(\d+(?:\.\d+)?)/.exec(n)?.[1] ?? 0);
  const score = (n: string) => ver(n) * 100 - (/preview/.test(n) ? 30 : 0) - (/lite/.test(n) ? 50 : 0);
  return [...flash].sort((a, b) => score(b) - score(a))[0];
}

/** Panggil generateContent. Jika model 404 (dipensiunkan/salah nama) -> cari model yang tersedia di ListModels lalu ulangi. 503/429 diulang sekali. */
export async function geminiGenerate(key: string, body: unknown, preferred = CFG.geminiModel): Promise<{ json: any; model: string }> {
  let model = resolved ?? preferred, triedDiscover = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${BASE}/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body),
    });
    if (res.ok) { resolved = model; return { json: await res.json(), model }; }
    const txt = (await res.text().catch(() => '')).slice(0, 300);
    if ((res.status === 404 || (res.status === 400 && /not found|not supported/i.test(txt))) && !triedDiscover) {
      triedDiscover = true;
      const alt = pickModel(await listModels(key));
      console.warn(`[gemini] model "${model}" tidak tersedia (HTTP ${res.status}). Model yang ditemukan: ${alt ?? 'tidak ada'}`);
      if (alt && alt !== model) { model = alt; continue; }
    }
    if ((res.status === 503 || res.status === 429) && attempt < 3) { await new Promise(r => setTimeout(r, 6000)); continue; }
    throw new Error(`HTTP ${res.status} (${model}): ${txt}`);
  }
  throw new Error('Gemini: gagal setelah beberapa percobaan');
}
