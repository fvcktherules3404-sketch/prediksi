/** Hanya sepak bola putra senior. Tim/liga junior (U15-U23), wanita, dan tim cadangan dilewati:
 *  datanya tipis, rotasinya acak, dan rumus ini tidak divalidasi untuk itu. */
const BAD = /(^|[\s(])U[-\s]?(1[5-9]|2[0-3])($|[\s)])|\bW$|\(W\)|women|feminin|femenin|féminin|femminile|youth|junior|reserve|amateur|\b(II|III)$|\bB$/i;
export function isSeniorMen(f: any): boolean {
  const names = [f?.teams?.home?.name, f?.teams?.away?.name, f?.league?.name].map(x => String(x ?? ''));
  return !names.some(n => BAD.test(n.trim()));
}
