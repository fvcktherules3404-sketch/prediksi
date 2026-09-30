import { useEffect, useMemo, useState } from 'react';
import type { Prediction, PredictionsFile, Metadata, Calibration, MarketTotal, HistRow, HitStat } from '../shared/types.ts';
import { pickOptions, hdpPick } from '../shared/picks.ts';
import './picks.css';

const base = import.meta.env.BASE_URL;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const fmtLine = (l: number) => (l > 0 ? `+${l}` : `${l}`);
const time = (iso: string) => new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' WIB';

function Form({ f }: { f?: string | null }) {
  if (!f) return null;
  return <span className="form">{f.slice(-5).split('').map((c, i) => <i key={i} className={c}>{c}</i>)}</span>;
}
function Src({ s }: { s?: 'official' | 'own' | 'ai' | 'elo' | 'market' }) {
  if (s === 'market') return <em className="src ai" title="Tidak ada klasemen/Elo untuk tim ini: prediksi hanya dari odds pasar (keyakinan dipotong)">Pasar</em>;
  if (s === 'elo') return <em className="src ai" title="Kekuatan tim dari peringkat Elo (tanpa klasemen musim ini)">Elo</em>;
  if (s === 'ai') return <em className="src ai" title="Data klasemen dari AI (Gemini + pencarian web), belum terverifikasi">AI?</em>;
  if (s === 'own') return <em className="src own" title="Klasemen dihitung dari hasil pertandingan yang dikumpulkan sendiri; sampel bisa masih kecil">hasil</em>;
  return null;
}
const acc = (x: number | null | undefined) => (x === null || x === undefined ? '–' : `${Math.round(x * 100)}%`);
function Track({ c }: { c: Calibration }) {
  if (!c.n) return <div className="track"><b>Rekam jejak</b> — belum ada laga yang selesai dinilai. Akan terisi otomatis setelah hasil pertandingan terkumpul.</div>;
  const few = c.n < 30;
  return (
    <details className="track">
      <summary><b>Rekam jejak</b> · {c.n} laga dinilai · tebakan 1X2 benar {acc(c.acc)} · Brier {c.brier?.toFixed(3)} <small>(acak {c.uniform.brier.toFixed(3)}, makin kecil makin baik)</small></summary>
      {few && <p className="sub">Baru {c.n} laga: angka masih sangat berfluktuasi dan belum cukup untuk menyimpulkan apa pun.</p>}
      <p>Log-loss {c.logloss?.toFixed(3)} <small>(acak {c.uniform.logloss.toFixed(3)})</small> · Over/Under 2.5 benar {acc(c.ou25.acc)} ({c.ou25.n}) · BTTS benar {acc(c.btts.acc)} ({c.btts.n})</p>
      <p><b>Apakah keyakinan tinggi memang lebih sering benar?</b> Tinggi {acc(c.byLevel.high.acc)} ({c.byLevel.high.n}) · Sedang {acc(c.byLevel.medium.acc)} ({c.byLevel.medium.n}) · Rendah {acc(c.byLevel.low.acc)} ({c.byLevel.low.n})</p>
      {c.market.n > 0 && <p>Pasar vs model ({c.market.n} laga): log-loss model {c.market.llModel?.toFixed(3) ?? '–'} · pasar {c.market.llMarket?.toFixed(3) ?? '–'} · gabungan {c.market.llBlend?.toFixed(3) ?? '–'}</p>}
      <p><small>{c.tuning.note}</small></p>
      {!!c.recent.length && <p className="rec">{c.recent.slice(0, 12).map((r, i) => <span key={i} className={r.hit ? 'ok' : 'no'} title={`${r.home} ${r.score} ${r.away} · pick ${r.pick}`}>{r.hit ? '✓' : '✗'} {r.home} {r.score} {r.away}</span>)}</p>}
    </details>
  );
}
const tot = (t?: MarketTotal) => (t && t.n ? `${t.hit}/${t.n} (${acc(t.acc)})` : '–');
const mark = (r: 'ok' | 'no' | 'push') => (r === 'ok' ? '✓' : r === 'no' ? '✗' : '↔');
type HTab = 'x12' | 'hdp' | 'ou' | 'btts' | 'combo';
const HTABS: [HTab, string][] = [['x12', '1X2'], ['hdp', 'HDP'], ['ou', 'Over/Under'], ['btts', 'BTTS'], ['combo', 'Gabungan']];
interface HItem { id: number; label: string; res: 'ok' | 'no' | 'push'; note: string; title: string }
/** Halaman Riwayat: ringkasan rekam jejak, total benar, winrate gabungan, dan daftar SEMUA laga dinilai per pasar (tab). Chip ✓ = tebakan benar, ✗ = salah. */
function History({ c, src, setSrc }: { c: Calibration; src: 'formula' | 'ai'; setSrc: (v: 'formula' | 'ai') => void }) {
  const [tab, setTab] = useState<HTab>('x12');
  const ai = src === 'ai';
  const sw = <div className="tabs">{([['formula', '📊 Riwayat Rumus'], ['ai', '🤖 Riwayat AI']] as const).map(([k, l]) => <button key={k} className={src === k ? 'on' : ''} onClick={() => setSrc(k)}>{l}</button>)}</div>;
  if (!c.n) return <div className="track"><b>Riwayat</b> — belum ada laga yang selesai dinilai. Akan terisi otomatis setelah hasil pertandingan terkumpul.</div>;
  if (ai && !c.ai.own?.n) return <section className="hist">{sw}<div className="track"><b>Riwayat AI</b> — belum ada laga berpick AI yang selesai dinilai.</div></section>;
  const t = ai ? c.aiTotals : c.totals, hist = ai ? c.aiHistory : c.history, cnt = (h: HitStat): MarketTotal => ({ n: h.n, hit: Math.round((h.acc ?? 0) * h.n), acc: h.acc });
  const x12 = t?.x12 ?? (ai ? undefined : { n: c.n, hit: Math.round((c.acc ?? 0) * c.n), acc: c.acc }), ou = t?.ou25 ?? (ai ? undefined : cnt(c.ou25)), bt = t?.btts ?? (ai ? undefined : cnt(c.btts));
  const pk1 = (home: string, away: string, k: string) => (k === '1' ? `${home} menang` : k === '2' ? `${away} menang` : 'Seri');
  const items: HItem[] = hist
    ? hist.flatMap((r: HistRow): HItem[] => {
      const label = `${r.home} ${r.score} ${r.away}`, title = `${r.league ?? ''} · ${time(new Date(r.ts * 1000).toISOString())} · keyakinan ${r.conf}`;
      const it = (res: 'ok' | 'no' | 'push', note: string): HItem[] => [{ id: r.id, label, res, note, title }];
      const ok = (b: boolean) => (b ? 'ok' as const : 'no' as const);
      if (tab === 'x12') return it(ok(r.x12.hit), pk1(r.home, r.away, r.x12.pick));
      if (tab === 'ou') return r.ou ? it(ok(r.ou.hit), `${r.ou.pick === 'over' ? 'Over' : 'Under'} 2.5`) : [];
      if (tab === 'btts') return r.btts ? it(ok(r.btts.hit), `BTTS ${r.btts.pick === 'yes' ? 'Ya' : 'Tidak'}`) : [];
      if (tab === 'hdp') return r.hdp ? it(r.hdp.res === 'win' ? 'ok' : r.hdp.res === 'loss' ? 'no' : 'push', `${r.hdp.side === '1' ? r.home : r.away} ${fmtLine(r.hdp.line)}${r.hdp.res === 'push' ? ' (push)' : ''}`) : [];
      const m = (b: boolean) => (b ? '✓' : '✗');
      return r.combo3 === null || !r.ou || !r.btts ? [] : it(ok(r.combo3), `1X2 ${m(r.x12.hit)} · O/U ${m(r.ou.hit)} · BTTS ${m(r.btts.hit)}${r.hdp ? ` · HDP ${r.hdp.res === 'win' ? '✓' : r.hdp.res === 'loss' ? '✗' : '↔'}` : ''}`);
    })
    : tab === 'x12' && !ai ? c.recent.map((r, i) => ({ id: i, label: `${r.home} ${r.score} ${r.away}`, res: r.hit ? 'ok' as const : 'no' as const, note: pk1(r.home, r.away, r.pick), title: '' })) : [];
  const nOk = items.filter(i => i.res === 'ok').length, nNo = items.filter(i => i.res === 'no').length, nPush = items.length - nOk - nNo;
  return (
    <section className="hist">
      {sw}
      {ai ? <div className="track">
        <p><b>Rekam jejak AI</b> · pick AI benar {acc(c.ai.own?.acc)} ({c.ai.own?.n} laga) · rumus pada laga yang sama {acc(c.ai.formulaSame?.acc)}</p>
        <p>Over/Under 2.5 benar {acc(c.ai.ou25?.acc)} ({c.ai.ou25?.n ?? 0}) · BTTS benar {acc(c.ai.btts?.acc)} ({c.ai.btts?.n ?? 0}) · HDP menang {acc(c.ai.hdp?.acc)} ({c.ai.hdp?.n ?? 0}, push tidak dihitung)</p>
        <p><small>AI memprediksi mandiri (tanpa angka rumus), jadi hanya laga yang punya opini AI yang masuk sini. Pasar yang tidak diisi AI dilewati. {(c.ai.own?.n ?? 0) < 30 ? 'Sampel masih sangat kecil; jangan disimpulkan.' : ''}</small></p>
      </div> : <div className="track">
        <p><b>Rekam jejak</b> · {c.n} laga dinilai · tebakan 1X2 benar {acc(c.acc)} · Brier {c.brier?.toFixed(3)} <small>(acak {c.uniform.brier.toFixed(3)}, makin kecil makin baik)</small></p>
        <p>Log-loss {c.logloss?.toFixed(3)} <small>(acak {c.uniform.logloss.toFixed(3)})</small> · Over/Under 2.5 benar {acc(c.ou25.acc)} ({c.ou25.n}) · BTTS benar {acc(c.btts.acc)} ({c.btts.n})</p>
        <p><b>Apakah keyakinan tinggi memang lebih sering benar?</b> Tinggi {acc(c.byLevel.high.acc)} ({c.byLevel.high.n}) · Sedang {acc(c.byLevel.medium.acc)} ({c.byLevel.medium.n}) · Rendah {acc(c.byLevel.low.acc)} ({c.byLevel.low.n})</p>
        {c.market.n > 0 && <p>Pasar vs model ({c.market.n} laga): log-loss model {c.market.llModel?.toFixed(3) ?? '–'} · pasar {c.market.llMarket?.toFixed(3) ?? '–'} · gabungan {c.market.llBlend?.toFixed(3) ?? '–'}</p>}
        <p><small>{c.tuning.note}</small></p>
      </div>}
      <h2 className="sec">🏆 Total benar</h2>
      <div className="stats">
        <div><small>Tebak menang (1X2)</small><b>{tot(x12)}</b></div>
        <div><small>Over/Under 2.5</small><b>{tot(ou)}</b></div>
        <div><small>BTTS</small><b>{tot(bt)}</b></div>
        <div><small>HDP <em>(push {t?.hdpPush ?? 0} tidak dihitung)</em></small><b>{tot(t?.hdp)}</b></div>
      </div>
      <h2 className="sec">📈 Winrate</h2>
      <div className="stats">
        <div><small>Keseluruhan · semua tebakan digabung</small><b>{tot(t?.overall)}</b></div>
        <div><small>Gabungan 3 pasar · 1X2 + O/U + BTTS benar semua</small><b>{tot(t?.combo3)}</b></div>
        <div><small>Gabungan 4 pasar · + HDP benar semua</small><b>{tot(t?.combo4)}</b></div>
      </div>
      <p className="sub"><small>Keseluruhan = jumlah tebakan benar dari semua pasar (1X2, O/U 2.5, BTTS, HDP) dibagi jumlah tebakan. Gabungan = satu laga benar hanya bila semua pasarnya benar; salah satu meleset berarti salah.{ai ? ' Untuk AI, gabungan hanya menghitung laga yang diisi AI di ketiga pasar (1X2, O/U, BTTS); gabungan 4 pasar juga butuh HDP.' : ''} HDP hanya ada bila laga punya pick HDP (peluang ≥ 50%), jadi gabungan 4 pasar hanya menghitung laga itu. HDP push (uang kembali) tidak dihitung.</small></p>
      {!t && <p className="sub"><small>{ai ? 'Total, winrate, dan daftar laga AI akan terisi setelah update otomatis berikutnya.' : 'Total HDP, winrate keseluruhan & gabungan, serta daftar laga per pasar akan terisi setelah update otomatis berikutnya (sementara tampil 24 laga terakhir untuk 1X2).'}</small></p>}
      <h2 className="sec">📜 Semua laga dinilai <small>(terbaru di atas)</small></h2>
      <div className="tabs">{HTABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      <details className="how"><summary>Cara membaca ✓ / ✗</summary>
        <p><b>1X2:</b> ✓ bila hasil 90 menit sama dengan tebakan rumus (kandang menang / seri / tandang menang), ✗ bila beda. Seri hanya benar bila skor akhirnya seri; perpanjangan waktu & penalti tidak dihitung.</p>
        <p><b>Over/Under 2.5:</b> tebak Over bila peluang Over ≥ 50%, kalau tidak Under. ✓ bila total gol 3+ (Over) atau 2 ke bawah (Under).</p>
        <p><b>BTTS:</b> tebak Ya bila peluang ≥ 50%. ✓ bila kedua tim mencetak gol (Ya) atau salah satunya nirbobol (Tidak).</p>
        <p><b>HDP:</b> pick HDP di kartu (HDP - bila tim unggulan, HDP + bila tim lemah). ✓ menang (penuh/setengah), ✗ kalah, ↔ push, tidak dihitung.</p>
      </details>
      <p className="sub">{HTABS.find(x => x[0] === tab)![1]}: ✓ {nOk} · ✗ {nNo}{nPush ? ` · ↔ ${nPush}` : ''}{nOk + nNo ? ` · benar ${Math.round(nOk / (nOk + nNo) * 100)}%` : ''}</p>
      <div className="track"><div className="rec hscroll">
        {items.map((i, k) => <span key={`${i.id}-${k}`} className={i.res === 'ok' ? 'ok' : i.res === 'no' ? 'no' : 'push'} title={i.title}>{mark(i.res)} {i.label} <small>· {i.note}</small></span>)}
        {!items.length && <span>{tab === 'x12' || c.history ? 'Belum ada data untuk pasar ini.' : 'Akan terisi setelah update otomatis berikutnya.'}</span>}
      </div></div>
    </section>
  );
}

/** Di bawah xG: 1X2 + satu pilihan lain dengan peluang terbesar (HDP -/+, Over/Under, BTTS; tanpa double chance). */
function Vs({ p }: { p: Prediction }) {
  const { main, best } = pickOptions(p);
  return (
    <div className="vs pkbox" title="1X2 dan satu pilihan lain dengan peluang terbesar (HDP -/+, Over/Under, BTTS).">
      <small>xG {p.xg.home.toFixed(2)} - {p.xg.away.toFixed(2)}</small>
      {[main, best].map(o => <div key={o.kind} className={`pk ${o.kind}`}><em>{o.tag}</em><strong>{o.label}</strong><span>{pct(o.p)}</span></div>)}
    </div>
  );
}
function Card({ p }: { p: Prediction }) {
  const { home: h, draw: d, away: a } = p.probs;
  return (
    <article className="card">
      <header><span>{p.league.name}{p.league.country ? ` · ${p.league.country}` : ''}</span><span>{time(p.kickoff)}</span></header>
      {p.preview && <div className="prev" title="Dibuat sesi pagi. Dihitung ulang otomatis jam 21:00 WIB dengan odds & berita terbaru.">⏳ Pratinjau · diperbarui 21:00 WIB</div>}
      <div className="teams">
        <div>{p.home.logo && <img src={p.home.logo} alt="" loading="lazy" />}<b>{p.home.name}</b><small>#{p.home.rank ?? '-'} <Form f={p.home.form} /><Src s={p.home.dataSource} /></small></div>
        <Vs p={p} />
        <div>{p.away.logo && <img src={p.away.logo} alt="" loading="lazy" />}<b>{p.away.name}</b><small>#{p.away.rank ?? '-'} <Form f={p.away.form} /><Src s={p.away.dataSource} /></small></div>
      </div>
      <div className="bar"><span className="h" style={{ width: pct(h) }}>{pct(h)}</span><span className="d" style={{ width: pct(d) }}>{pct(d)}</span><span className="a" style={{ width: pct(a) }}>{pct(a)}</span></div>
      <div className="odds">Fair odds: {p.fairOdds.home} / {p.fairOdds.draw} / {p.fairOdds.away}</div>
      <div className="chips">
        <span className={`chip ${p.confidenceLevel}`}>Keyakinan {p.confidence}</span>
        <span className="chip" title="Hasil paling mungkin menurut rumus (1X2)">Prediksi 1X2: {p.picks.result}</span>
        {Math.abs(h - a) < 0.05 && <span className="chip tight" title="Kedua tim nyaris setara; seri sangat mungkin. Pick tetap satu hasil dengan peluang tertinggi.">⚖️ Ketat · Seri {pct(d)}</span>}
        {p.picks.safe && <span className="chip">Aman: {p.picks.safe}</span>}
        {(() => { const hd = hdpPick(p); return hd && <span className="chip" title={`HDP ${hd.kind === 'hdpFav' ? '- (tim unggulan)' : '+ (tim lemah)'}: peluang menang handicap, setengah menang dihitung, push (uang kembali) setengah`}>HDP: {hd.label} ({pct(hd.p)})</span>; })()}
        <span className="chip">{p.picks.goals} ({pct(p.picks.goals === 'Over 2.5' ? p.ou[1].over : p.ou[1].under)})</span>
        {p.market && <span className="chip" title={`Peluang implisit pasar (margin dibuang, ${p.market.books} bandar) ikut dihitung`}>Pasar {pct(p.market.home)}/{pct(p.market.draw)}/{pct(p.market.away)}</span>}
        {p.absences && <span className="chip" title="Pemain absen memengaruhi xG">🩹 Absen {p.absences.home.length}-{p.absences.away.length}</span>}
        {p.stakes && <span className={`chip stake ${p.stakes.home.kind === 'safe' ? 'safe' : 'live'}`} title={`Situasi tabel (progres musim ${pct(p.stakes.phase)}). Tim yang masih berebut sesuatu dinilai lebih tajam daripada lawan yang sudah aman; penyesuaian xG ${p.stakes.adj.home >= 0 ? '+' : ''}${(p.stakes.adj.home * 100).toFixed(1)}% / ${p.stakes.adj.away >= 0 ? '+' : ''}${(p.stakes.adj.away * 100).toFixed(1)}% (kandang/tandang)`}>🎯 {p.home.name}: {p.stakes.home.label}</span>}
        {p.stakes && <span className={`chip stake ${p.stakes.away.kind === 'safe' ? 'safe' : 'live'}`}>🎯 {p.away.name}: {p.stakes.away.label}</span>}
        <span className="chip">BTTS {pct(p.btts.yes)}</span>
        <span className="chip">AH adil {fmtLine(p.fairHandicap)}</span>
      </div>
      <p className="ai">{p.aiSummary}</p>
      {p.aiOpinion && <p className="aiop"><b>🤖 Opini AI:</b> {p.aiOpinion.pick === '1' ? `${p.home.name} menang` : p.aiOpinion.pick === '2' ? `${p.away.name} menang` : 'Seri'}{p.aiOpinion.score ? ` (${p.aiOpinion.score})` : ''} · <span className={p.aiOpinion.agree ? 'ok' : 'no'}>{p.aiOpinion.agree ? 'sepakat dengan rumus' : 'beda dengan rumus'}</span><br /><small>{p.aiOpinion.reason}</small></p>}
      <details><summary>Detail skor, gol & handicap</summary>
        {p.absences && <div><p><b>Pemain absen/diragukan</b> ({p.absences.source === 'api' ? 'API, peran belum diketahui' : p.absences.source === 'both' ? 'AI + API' : 'AI + pencarian web, belum terverifikasi'}) — penyesuaian xG {p.absences.adj.home >= 0 ? '+' : ''}{(p.absences.adj.home * 100).toFixed(1)}% / {p.absences.adj.away >= 0 ? '+' : ''}{(p.absences.adj.away * 100).toFixed(1)}%</p>
          {(['home', 'away'] as const).map(sd => <p key={sd}><b>{p[sd].name}:</b> {p.absences![sd].length ? p.absences![sd].map(a => `${a.name}${a.pos !== '?' ? ` (${a.pos}${a.role === 'key' ? ', kunci' : ''})` : ''}${a.status === 'doubt' ? ' ?' : ''}`).join(', ') : 'tidak ada laporan'}</p>)}</div>}
        {p.modelProbs && <p><b>Sumber peluang:</b> model {pct(p.modelProbs.home)}/{pct(p.modelProbs.draw)}/{pct(p.modelProbs.away)}{p.market ? ` · pasar ${pct(p.market.home)}/${pct(p.market.draw)}/${pct(p.market.away)} (bobot ${pct(p.calib?.marketW ?? 0)})` : ' · tanpa data pasar'} → akhir {pct(h)}/{pct(d)}/{pct(a)}</p>}
        {p.conf && <p><b>Keyakinan {p.confidence}</b> = ketegasan {pct(p.conf.core)} × kualitas data {pct(p.conf.quality)} × kesepakatan sumber {pct(p.conf.agreement)}{p.conf.comp < 1 ? ` × laga persahabatan ${pct(p.conf.comp)}` : ''}</p>}
        <p><b>Skor teratas:</b> {p.topScores.map(s => `${s.score} (${pct(s.p)})`).join(' · ')}</p>
        <p><b>Over/Under:</b> {p.ou.map(o => `${o.line}: O ${pct(o.over)} / U ${pct(o.under)}`).join(' · ')}</p>
        <p><b>Double chance:</b> 1X {pct(p.doubleChance.hx)} · X2 {pct(p.doubleChance.xa)} · 12 {pct(p.doubleChance.ha)}</p>
        <div className="scroll"><table><thead><tr><th>Handicap {p.home.name}</th><th>Peluang menang*</th><th>Fair odds</th><th>Push</th></tr></thead><tbody>
          {p.handicap.map(x => <tr key={x.line} className={x.line === p.fairHandicap ? 'hl' : ''}><td>{fmtLine(x.line)}</td><td>{pct(x.pCover)}</td><td>{x.fairOdds}</td><td>{pct(x.push)}</td></tr>)}
        </tbody></table></div>
        <small>*win + ½ half-win. Fair odds = odds impas (EV 0) menurut model, bukan odds bandar.</small>
      </details>
    </article>
  );
}

const pickLabel = (p: Prediction, k: '1' | 'X' | '2') => (k === '1' ? `${p.home.name} menang` : k === '2' ? `${p.away.name} menang` : 'Seri');
function AiCard({ p }: { p: Prediction }) {
  const o = p.aiOpinion;
  if (!o) return null;
  return (
    <article className="card">
      <header><span>{p.league.name}{p.league.country ? ` · ${p.league.country}` : ''}</span><span>{time(p.kickoff)}</span></header>
      <div className="teams">
        <div>{p.home.logo && <img src={p.home.logo} alt="" loading="lazy" />}<b>{p.home.name}</b></div>
        <div className="vs">Skor AI<br /><b>{o.score ?? '–'}</b></div>
        <div>{p.away.logo && <img src={p.away.logo} alt="" loading="lazy" />}<b>{p.away.name}</b></div>
      </div>
      <div className="chips">
        <span className="chip">🤖 Prediksi AI: {pickLabel(p, o.pick)}</span>
        <span className="chip" title="Pick dari rumus (Poisson/Elo/pasar), dihitung terpisah dari AI">Rumus: {p.picks.result}</span>
        <span className={`chip ${o.agree ? 'high' : 'low'}`}>{o.agree ? 'AI & rumus sepakat' : 'AI & rumus beda'}</span>
      </div>
      <div className="chips">
        {o.ou25 && <span className="chip" title={`Rumus: ${p.picks.goals}`}>{o.ou25 === 'over' ? 'Over 2.5' : 'Under 2.5'}</span>}
        {o.btts && <span className="chip" title={`Rumus: BTTS ${pct(p.btts.yes)}`}>BTTS {o.btts === 'yes' ? 'Ya' : 'Tidak'}</span>}
        {o.hdp && <span className="chip" title={`Rumus: AH adil ${fmtLine(p.fairHandicap)} (kandang)`}>HDP {o.hdp.side === '1' ? p.home.name : p.away.name} {fmtLine(o.hdp.line)}</span>}
      </div>
      <p className="aiop"><b>Alasan:</b> {o.reason}</p>
      {o.style && <p className="aiop"><b>Pola permainan:</b> {o.style}</p>}
    </article>
  );
}
function AiTrack({ c, onOpen }: { c: Calibration; onOpen: () => void }) {
  const o = c.ai.own, f = c.ai.formulaSame;
  if (!o || !o.n) return <div className="track"><b>Rekam jejak AI</b> — belum ada laga berpick AI yang selesai dinilai.</div>;
  return <div className="track"><b>Rekam jejak AI</b> · pick AI benar {acc(o.acc)} ({o.n} laga) · rumus pada laga yang sama {acc(f?.acc)} · Over/Under {acc(c.ai.ou25?.acc)} ({c.ai.ou25?.n ?? 0}) · BTTS {acc(c.ai.btts?.acc)} ({c.ai.btts?.n ?? 0}) · HDP menang {acc(c.ai.hdp?.acc)} ({c.ai.hdp?.n ?? 0}, push tidak dihitung). {o.n < 30 && <small>Sampel masih sangat kecil; jangan disimpulkan.</small>}
    <div><button className="openhist" onClick={onOpen}>📜 Buka riwayat AI lengkap →</button></div></div>;
}

/** Sesi laga: 'pagi' = kickoff 06:00–20:59 WIB, 'malam' = 21:00–05:59 WIB (data lama tanpa field slot dihitung dari jam kickoff). */
const slotOf = (m: Prediction): 'pagi' | 'malam' => {
  if (m.slot) return m.slot;
  const h = (new Date(m.kickoff).getUTCHours() + 7) % 24;
  return h >= 6 && h < 21 ? 'pagi' : 'malam';
};
const TOP_N = 10, MIN_SHOWN = 5;

export default function App() {
  const [data, setData] = useState<PredictionsFile | null>(null);
  const [meta, setMeta] = useState<Metadata | null>(null);
  const [cal, setCal] = useState<Calibration | null>(null);
  const [err, setErr] = useState(''); const [tab, setTab] = useState<'formula' | 'ai'>('formula');
  const [league, setLeague] = useState('home'); const [sesi, setSesi] = useState<'all' | 'pagi' | 'malam'>('all');
  const [view, setView] = useState<'prediksi' | 'riwayat'>('prediksi'); const [hsrc, setHsrc] = useState<'formula' | 'ai'>('formula');
  const [menu, setMenu] = useState(false); const [q, setQ] = useState(''); const [sort, setSort] = useState<'time' | 'conf'>('time');
  useEffect(() => {
    const t = Date.now();
    fetch(`${base}data/predictions.json?t=${t}`).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); }).then(setData).catch(e => setErr(String(e)));
    fetch(`${base}data/metadata.json?t=${t}`).then(r => (r.ok ? r.json() : null)).then(setMeta).catch(() => {});
    fetch(`${base}data/calibration.json?t=${t}`).then(r => (r.ok ? r.json() : null)).then(setCal).catch(() => {});
  }, []);
  const matches = data?.matches ?? [];
  const inSesi = useMemo(() => matches.filter(m => sesi === 'all' || slotOf(m) === sesi), [matches, sesi]);
  // Menu liga lengkap: semua liga yang punya laga pada hari itu (+ jumlah laga), urut jumlah laga lalu nama
  const leagues = useMemo(() => {
    const c = new Map<string, number>(); for (const m of inSesi) c.set(m.league.name, (c.get(m.league.name) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [inSesi]);
  useEffect(() => { if (league !== 'home' && league !== 'all' && !leagues.some(([n]) => n === league)) setLeague('home'); }, [leagues, league]);
  // Beranda: hanya laga keyakinan TINGGI (maks 10), yang belum mulai didahulukan. Bila yang tinggi < 5, diisi laga terbaik berikutnya.
  const top = useMemo(() => {
    const now = Date.now(), byConf = (a: Prediction, b: Prediction) => b.confidence - a.confidence || (b.headline?.strength ?? 0) - (a.headline?.strength ?? 0);
    const rank = (xs: Prediction[]) => [...xs.filter(m => m.timestamp * 1000 > now - 0.5 * 3.6e6).sort(byConf), ...xs.filter(m => m.timestamp * 1000 <= now - 0.5 * 3.6e6).sort(byConf)];
    const high = rank(inSesi.filter(m => m.confidenceLevel === 'high')).slice(0, TOP_N);
    if (high.length >= MIN_SHOWN) return high;
    return [...high, ...rank(inSesi.filter(m => m.confidenceLevel !== 'high')).slice(0, MIN_SHOWN - high.length)];
  }, [inSesi]);
  // Rekomendasi pick: per laga yang belum mulai, 1X2 + pilihan lain yang cukup tegas (HDP -/+, Over/Under, BTTS), diurut ketegasan
  const recs = useMemo(() => top.filter(m => m.timestamp * 1000 > Date.now()).map(m => {
    const o = pickOptions(m), opts = [o.main, ...o.others.filter(x => x.strong)];
    return { m, opts, s: Math.max(...opts.map(x => x.strength)) };
  }).sort((a, b) => b.s - a.s), [top]);
  // Menu liga lengkap dikelompokkan per negara
  const byCountry = useMemo(() => {
    const g = new Map<string, Map<string, number>>();
    for (const m of inSesi) { const c = m.league.country || 'Lainnya'; const l = g.get(c) ?? g.set(c, new Map()).get(c)!; l.set(m.league.name, (l.get(m.league.name) ?? 0) + 1); }
    return [...g.entries()].map(([c, l]) => ({ c, l: [...l.entries()].sort((a, b) => b[1] - a[1]), n: [...l.values()].reduce((a, b) => a + b, 0) })).sort((a, b) => b.n - a.n || a.c.localeCompare(b.c));
  }, [inSesi]);
  const list = useMemo(() => inSesi
    .filter(m => (league === 'all' || m.league.name === league) && `${m.home.name} ${m.away.name}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (sort === 'time' ? a.timestamp - b.timestamp : b.confidence - a.confidence)), [inSesi, league, q, sort]);
  const isHome = league === 'home' && !q;
  const shown = isHome ? top : list;

  return (
    <main>
      <h1>⚽ Prediksi Bola Statistik</h1>
      <p className="sub">Model Poisson + Dixon-Coles + Elo, digabung probabilitas pasar dan dikalibrasi dari rekam jejak. 100% gratis.</p>
      {meta?.status === 'failed' && <div className="warn">Update terakhir gagal ({meta.message}). Menampilkan prediksi terakhir yang berhasil.</div>}
      {err && <div className="warn">Belum ada data prediksi ({err}). Jalankan workflow “Daily Predictions” di GitHub Actions.</div>}
      {data && <p className="sub">Laga {time(data.window.start)} → {time(data.window.end)} · diperbarui {time(data.generatedAt)} · update otomatis 06:00 (laga sampai sore) & 21:00 WIB (laga malam–dini) · AI: {data.ai.used ? `${data.ai.summarized} ringkasan (${data.ai.model})` : 'tidak aktif'}</p>}
      <div className="tabs"><button className={view === 'prediksi' ? 'on' : ''} onClick={() => setView('prediksi')}>⚽ Prediksi</button><button className={view === 'riwayat' ? 'on' : ''} onClick={() => setView('riwayat')}>📜 Riwayat</button></div>
      {view === 'riwayat' ? (cal ? <History c={cal} src={hsrc} setSrc={setHsrc} /> : <p className="sub">Belum ada data riwayat.</p>) : <>
      {cal && <Track c={cal} />}
      <div className="sesi">{([['all', 'Seharian'], ['pagi', '☀️ 06:00–21:00'], ['malam', '🌙 21:00–06:00']] as const).map(([k, l]) => <button key={k} className={sesi === k ? 'on' : ''} onClick={() => setSesi(k)}>{l}</button>)}</div>
      <nav className="lg" aria-label="Pilih liga">
        <button className={league === 'home' ? 'on' : ''} onClick={() => { setLeague('home'); setMenu(false); }}>🏠 Beranda</button>
        <button className={menu ? 'on' : ''} onClick={() => setMenu(v => !v)}>☰ Semua liga <em>{leagues.length} liga · {inSesi.length} laga</em></button>
        {league !== 'home' && league !== 'all' && <button className="on" onClick={() => setLeague('home')}>{league} ✕</button>}
      </nav>
      {menu && <div className="lgmenu">
        <button className={league === 'all' ? 'on' : ''} onClick={() => { setLeague('all'); setMenu(false); }}>Tampilkan semua laga ({inSesi.length})</button>
        {byCountry.map(g => <div key={g.c} className="ctry"><b>{g.c} <em>{g.n}</em></b>{g.l.map(([n, c]) => <button key={n} className={league === n ? 'on' : ''} onClick={() => { setLeague(n); setMenu(false); }}>{n} <em>{c}</em></button>)}</div>)}
      </div>}
      <div className="filters">
        <input placeholder="Cari tim…" value={q} onChange={e => setQ(e.target.value)} />
        <select value={sort} onChange={e => setSort(e.target.value as 'time' | 'conf')}><option value="time">Urut jam</option><option value="conf">Urut keyakinan</option></select>
      </div>
      {data && !shown.length && <p className="sub">Tidak ada pertandingan pada pilihan ini{q ? ' (sesuai pencarian)' : ''}.</p>}
      <div className="tabs"><button className={tab === 'formula' ? 'on' : ''} onClick={() => setTab('formula')}>📊 Prediksi Rumus</button><button className={tab === 'ai' ? 'on' : ''} onClick={() => setTab('ai')}>🤖 Opini AI</button></div>
      {isHome && tab === 'formula' && !!recs.length && <>
        <h2 className="sec">🎯 Rekomendasi pick <small>(1X2, HDP -/+, Over/Under, BTTS · laga yang belum mulai)</small></h2>
        <div className="recs">{recs.map(({ m, opts }) => <div key={m.id} className="rec">
          <span className="rt">{m.home.name} vs {m.away.name}<small>{m.league.name} · {time(m.kickoff)}</small></span>
          <div className="ropts">{opts.map(o => <span key={o.kind} className={`ro ${o.kind}`}><em>{o.tag}</em> <b>{o.label}</b> <i>{pct(o.p)}</i></span>)}</div>
          <span className={`chip ${m.confidenceLevel}`}>Keyakinan {m.confidence}</span>
        </div>)}</div>
      </>}
      {isHome && tab === 'formula' && !!shown.length && <h2 className="sec">🔥 Laga teratas · keyakinan tinggi <small>({shown.length} dari {inSesi.length} laga · buka “☰ Semua liga” untuk liga lainnya)</small></h2>}
      {tab === 'formula' ? <div className="grid">{shown.map(m => <Card key={m.id} p={m} />)}</div> : <>
        <p className="sub">Prediksi murni dari AI (Gemini + pencarian web). AI tidak diberi angka rumus dan tidak mengubah peluang di tab Prediksi Rumus. Hanya laga yang punya sumber web yang dianalisis ({shown.filter(m => m.aiOpinion).length} dari {shown.length} laga).</p>
        {cal && <AiTrack c={cal} onOpen={() => { setHsrc('ai'); setView('riwayat'); window.scrollTo(0, 0); }} />}
        <div className="grid">{shown.filter(m => m.aiOpinion).map(m => <AiCard key={m.id} p={m} />)}</div>
        {!shown.some(m => m.aiOpinion) && <p className="sub">Belum ada opini AI pada pilihan ini.</p>}
      </>}
      </>}
      <footer>Prediksi adalah estimasi statistik, bukan jaminan hasil. Cedera/skorsing hanya diperhitungkan sebagian (dari laporan yang tersedia), susunan pemain resmi tidak. Untuk hiburan &amp; analisis. Perjudian dilarang di Indonesia — jangan gunakan untuk taruhan.</footer>
    </main>
  );
}
