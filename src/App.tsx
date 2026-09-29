import { useEffect, useMemo, useState } from 'react';
import type { Prediction, PredictionsFile, Metadata, Calibration } from '../shared/types.ts';

const base = import.meta.env.BASE_URL;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const fmtLine = (l: number) => (l > 0 ? `+${l}` : `${l}`);
const time = (iso: string) => new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' WIB';

function Form({ f }: { f?: string | null }) {
  if (!f) return null;
  return <span className="form">{f.slice(-5).split('').map((c, i) => <i key={i} className={c}>{c}</i>)}</span>;
}
function Src({ s }: { s?: 'official' | 'own' | 'ai' | 'elo' }) {
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
function Card({ p }: { p: Prediction }) {
  const { home: h, draw: d, away: a } = p.probs;
  return (
    <article className="card">
      <header><span>{p.league.name}{p.league.country ? ` · ${p.league.country}` : ''}</span><span>{time(p.kickoff)}</span></header>
      <div className="teams">
        <div>{p.home.logo && <img src={p.home.logo} alt="" loading="lazy" />}<b>{p.home.name}</b><small>#{p.home.rank ?? '-'} <Form f={p.home.form} /><Src s={p.home.dataSource} /></small></div>
        <div className="vs">xG<br /><b>{p.xg.home.toFixed(2)} - {p.xg.away.toFixed(2)}</b></div>
        <div>{p.away.logo && <img src={p.away.logo} alt="" loading="lazy" />}<b>{p.away.name}</b><small>#{p.away.rank ?? '-'} <Form f={p.away.form} /><Src s={p.away.dataSource} /></small></div>
      </div>
      <div className="bar"><span className="h" style={{ width: pct(h) }}>{pct(h)}</span><span className="d" style={{ width: pct(d) }}>{pct(d)}</span><span className="a" style={{ width: pct(a) }}>{pct(a)}</span></div>
      <div className="odds">Fair odds: {p.fairOdds.home} / {p.fairOdds.draw} / {p.fairOdds.away}</div>
      <div className="chips">
        <span className={`chip ${p.confidenceLevel}`}>Keyakinan {p.confidence}</span>
        <span className="chip">Pick: {p.picks.result}</span>
        {Math.abs(h - a) < 0.05 && <span className="chip tight" title="Kedua tim nyaris setara; seri sangat mungkin. Pick tetap satu hasil dengan peluang tertinggi.">⚖️ Ketat · Seri {pct(d)}</span>}
        {p.picks.safe && <span className="chip">Aman: {p.picks.safe}</span>}
        <span className="chip">{p.picks.goals} ({pct(p.picks.goals === 'Over 2.5' ? p.ou[1].over : p.ou[1].under)})</span>
        {p.market && <span className="chip" title={`Peluang implisit pasar (margin dibuang, ${p.market.books} bandar) ikut dihitung`}>Pasar {pct(p.market.home)}/{pct(p.market.draw)}/{pct(p.market.away)}</span>}
        {p.absences && <span className="chip" title="Pemain absen memengaruhi xG">🩹 Absen {p.absences.home.length}-{p.absences.away.length}</span>}
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

export default function App() {
  const [data, setData] = useState<PredictionsFile | null>(null);
  const [meta, setMeta] = useState<Metadata | null>(null);
  const [cal, setCal] = useState<Calibration | null>(null);
  const [err, setErr] = useState('');
  const [league, setLeague] = useState('all'); const [q, setQ] = useState(''); const [sort, setSort] = useState<'time' | 'conf'>('time');
  useEffect(() => {
    const t = Date.now();
    fetch(`${base}data/predictions.json?t=${t}`).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); }).then(setData).catch(e => setErr(String(e)));
    fetch(`${base}data/metadata.json?t=${t}`).then(r => (r.ok ? r.json() : null)).then(setMeta).catch(() => {});
    fetch(`${base}data/calibration.json?t=${t}`).then(r => (r.ok ? r.json() : null)).then(setCal).catch(() => {});
  }, []);
  const leagues = useMemo(() => [...new Set((data?.matches ?? []).map(m => m.league.name))].sort(), [data]);
  const list = useMemo(() => (data?.matches ?? [])
    .filter(m => (league === 'all' || m.league.name === league) && `${m.home.name} ${m.away.name}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (sort === 'time' ? a.timestamp - b.timestamp : b.confidence - a.confidence)), [data, league, q, sort]);

  return (
    <main>
      <h1>⚽ Prediksi Bola Statistik</h1>
      <p className="sub">Model Poisson + Dixon-Coles + Elo, digabung probabilitas pasar dan dikalibrasi dari rekam jejak. 100% gratis.</p>
      {meta?.status === 'failed' && <div className="warn">Update terakhir gagal ({meta.message}). Menampilkan prediksi terakhir yang berhasil.</div>}
      {err && <div className="warn">Belum ada data prediksi ({err}). Jalankan workflow “Daily Predictions” di GitHub Actions.</div>}
      {data && <p className="sub">Window: {time(data.window.start)} → {time(data.window.end)} · diperbarui {time(data.generatedAt)} · AI: {data.ai.used ? `${data.ai.summarized} ringkasan (${data.ai.model})` : 'tidak aktif'}</p>}
      {cal && <Track c={cal} />}
      <div className="filters">
        <input placeholder="Cari tim…" value={q} onChange={e => setQ(e.target.value)} />
        <select value={league} onChange={e => setLeague(e.target.value)}><option value="all">Semua liga</option>{leagues.map(l => <option key={l}>{l}</option>)}</select>
        <select value={sort} onChange={e => setSort(e.target.value as 'time' | 'conf')}><option value="time">Urut jam</option><option value="conf">Urut keyakinan</option></select>
      </div>
      {data && !list.length && <p className="sub">Tidak ada pertandingan pada window ini{q || league !== 'all' ? ' (sesuai filter)' : ''}.</p>}
      <div className="grid">{list.map(m => <Card key={m.id} p={m} />)}</div>
      <footer>Prediksi adalah estimasi statistik, bukan jaminan hasil. Cedera/skorsing hanya diperhitungkan sebagian (dari laporan yang tersedia), susunan pemain resmi tidak. Untuk hiburan &amp; analisis. Perjudian dilarang di Indonesia — jangan gunakan untuk taruhan.</footer>
    </main>
  );
}