import { useEffect, useMemo, useState } from 'react';
import type { Prediction, PredictionsFile, Metadata } from '../shared/types.ts';

const base = import.meta.env.BASE_URL;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const fmtLine = (l: number) => (l > 0 ? `+${l}` : `${l}`);
const time = (iso: string) => new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' WIB';

function Form({ f }: { f?: string | null }) {
  if (!f) return null;
  return <span className="form">{f.slice(-5).split('').map((c, i) => <i key={i} className={c}>{c}</i>)}</span>;
}
function Card({ p }: { p: Prediction }) {
  const { home: h, draw: d, away: a } = p.probs;
  return (
    <article className="card">
      <header><span>{p.league.name}{p.league.country ? ` · ${p.league.country}` : ''}</span><span>{time(p.kickoff)}</span></header>
      <div className="teams">
        <div>{p.home.logo && <img src={p.home.logo} alt="" loading="lazy" />}<b>{p.home.name}</b><small>#{p.home.rank ?? '-'} <Form f={p.home.form} /></small></div>
        <div className="vs">xG<br /><b>{p.xg.home.toFixed(2)} - {p.xg.away.toFixed(2)}</b></div>
        <div>{p.away.logo && <img src={p.away.logo} alt="" loading="lazy" />}<b>{p.away.name}</b><small>#{p.away.rank ?? '-'} <Form f={p.away.form} /></small></div>
      </div>
      <div className="bar"><span className="h" style={{ width: pct(h) }}>{pct(h)}</span><span className="d" style={{ width: pct(d) }}>{pct(d)}</span><span className="a" style={{ width: pct(a) }}>{pct(a)}</span></div>
      <div className="odds">Fair odds: {p.fairOdds.home} / {p.fairOdds.draw} / {p.fairOdds.away}</div>
      <div className="chips">
        <span className={`chip ${p.confidenceLevel}`}>Keyakinan {p.confidence}</span>
        <span className="chip">Pick: {p.picks.result}</span>
        <span className="chip">{p.picks.goals} ({pct(p.picks.goals === 'Over 2.5' ? p.ou[1].over : p.ou[1].under)})</span>
        <span className="chip">BTTS {pct(p.btts.yes)}</span>
        <span className="chip">AH adil {fmtLine(p.fairHandicap)}</span>
      </div>
      <p className="ai">{p.aiSummary}</p>
      <details><summary>Detail skor, gol & handicap</summary>
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
  const [err, setErr] = useState('');
  const [league, setLeague] = useState('all'); const [q, setQ] = useState(''); const [sort, setSort] = useState<'time' | 'conf'>('time');
  useEffect(() => {
    const t = Date.now();
    fetch(`${base}data/predictions.json?t=${t}`).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); }).then(setData).catch(e => setErr(String(e)));
    fetch(`${base}data/metadata.json?t=${t}`).then(r => (r.ok ? r.json() : null)).then(setMeta).catch(() => {});
  }, []);
  const leagues = useMemo(() => [...new Set((data?.matches ?? []).map(m => m.league.name))].sort(), [data]);
  const list = useMemo(() => (data?.matches ?? [])
    .filter(m => (league === 'all' || m.league.name === league) && `${m.home.name} ${m.away.name}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (sort === 'time' ? a.timestamp - b.timestamp : b.confidence - a.confidence)), [data, league, q, sort]);

  return (
    <main>
      <h1>⚽ Prediksi Bola Statistik</h1>
      <p className="sub">Model Poisson + Dixon-Coles, dihitung otomatis tiap hari. 100% gratis.</p>
      {meta?.status === 'failed' && <div className="warn">Update terakhir gagal ({meta.message}). Menampilkan prediksi terakhir yang berhasil.</div>}
      {err && <div className="warn">Belum ada data prediksi ({err}). Jalankan workflow “Daily Predictions” di GitHub Actions.</div>}
      {data && <p className="sub">Window: {time(data.window.start)} → {time(data.window.end)} · diperbarui {time(data.generatedAt)} · AI: {data.ai.used ? `${data.ai.summarized} ringkasan (${data.ai.model})` : 'tidak aktif'}</p>}
      <div className="filters">
        <input placeholder="Cari tim…" value={q} onChange={e => setQ(e.target.value)} />
        <select value={league} onChange={e => setLeague(e.target.value)}><option value="all">Semua liga</option>{leagues.map(l => <option key={l}>{l}</option>)}</select>
        <select value={sort} onChange={e => setSort(e.target.value as 'time' | 'conf')}><option value="time">Urut jam</option><option value="conf">Urut keyakinan</option></select>
      </div>
      {data && !list.length && <p className="sub">Tidak ada pertandingan pada window ini{q || league !== 'all' ? ' (sesuai filter)' : ''}.</p>}
      <div className="grid">{list.map(m => <Card key={m.id} p={m} />)}</div>
      <footer>Prediksi adalah estimasi statistik, bukan jaminan hasil, dan tidak memperhitungkan cedera/susunan pemain. Untuk hiburan &amp; analisis. Perjudian dilarang di Indonesia — jangan gunakan untuk taruhan.</footer>
    </main>
  );
}
