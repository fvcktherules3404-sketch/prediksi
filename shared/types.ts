export interface Absence { name:string; pos:'GK'|'DEF'|'MID'|'FWD'|'?'; role:'key'|'starter'|'rotation'|'unknown'; status:'out'|'doubt'; reason?:string }
export interface AHLine { line:number; win:number; halfWin:number; push:number; halfLoss:number; loss:number; pCover:number; fairOdds:number }
export type DataSource = 'official'|'own'|'ai'|'elo'|'market';
export interface TeamInfo { id:number; name:string; logo?:string; rank?:number|null; form?:string|null; played:number; dataSource?:DataSource; elo?:number|null }
/** Probabilitas implisit pasar (odds bandar, margin sudah dibuang). Dipakai HANYA sebagai sinyal statistik. */
export interface MarketInfo { home:number; draw:number; away:number; over25?:number; books:number }
export interface Probs3 { home:number; draw:number; away:number }
/** Situasi tabel satu tim menjelang laga (lihat scripts/stakes.ts). need: 1 = sedang berebut sesuatu, 0 = tanpa target. */
export interface StakeInfo { kind:'title'|'europe'|'safe'|'relegation'; need:number; defending:boolean; label:string }
/** Prediksi utama satu laga (tampil besar di tengah kartu): pilihan pasar dengan ketegasan tertinggi. */
export interface Headline { market:'1x2'|'hdp'|'ou'|'btts'; label:string; sub?:string; p:number; strength:number }
export type Slot = 'pagi'|'malam';
export interface Prediction {
  id:number; kickoff:string; timestamp:number;
  league:{ id:number; name:string; country?:string; logo?:string; round?:string; season:number };
  home:TeamInfo; away:TeamInfo;
  xg:{ home:number; away:number };
  probs:Probs3;
  fairOdds:{ home:number; draw:number; away:number };
  doubleChance:{ hx:number; xa:number; ha:number };
  ou:{ line:number; over:number; under:number }[];
  btts:{ yes:number; no:number };
  topScores:{ score:string; p:number }[];
  handicap:AHLine[]; fairHandicap:number;
  confidence:number; confidenceLevel:'high'|'medium'|'low';
  /** Rincian skor keyakinan: core (ketegasan peluang) x kualitas data x kesepakatan sumber x jenis laga. */
  conf?:{ core:number; quality:number; agreement:number; comp:number };
  picks:{ result:string; pick1x2?:'1'|'X'|'2'; goals:string; safe?:string };
  /** Prediksi utama (HDP / Over-Under / tim-seri / BTTS). Dihitung scripts/headline.ts. */
  headline?:Headline;
  slot?:Slot;
  /** true = dibuat sesi pagi untuk laga malam/dini hari; akan dihitung ulang sesi 21:00 dengan odds & berita terbaru. */
  preview?:boolean;
  aiSummary:string;
  aiOpinion?:{ pick:'1'|'X'|'2'; score:string|null; reason:string; style?:string; btts?:'yes'|'no'; ou25?:'over'|'under'; hdp?:{ side:'1'|'2'; line:number }; agree:boolean; confAdj:number };
  absences?:{ home:Absence[]; away:Absence[]; source:'ai'|'api'|'both'; checked:boolean; adj:{ home:number; away:number } };
  /** Model murni (Poisson/Elo/absen) sebelum digabung pasar & kalibrasi. Dipakai evaluate.ts untuk menuning bobot. */
  modelProbs?:Probs3;
  /** Setelah digabung pasar, sebelum koreksi temperatur. */
  rawProbs?:Probs3;
  market?:MarketInfo;
  /** Taruhan laga: situasi tabel kedua tim, progres musim (0..1), dan penyesuaian xG yang dipakai (0 bila dimatikan). */
  stakes?:{ home:StakeInfo; away:StakeInfo; phase:number; adj:{ home:number; away:number } };
  calib?:{ tau:number; marketW:number };
}
export interface PredictionsFile {
  version:number; generatedAt:string; window:{ start:string; end:string }; slot?:Slot;
  ai:{ used:boolean; model?:string; summarized:number };
  api:{ used:number; limit:number };
  matches:Prediction[];
}
export interface Metadata {
  status:'ok'|'failed'|'partial'; message:string; generatedAt?:string; attemptedAt:string; lastSuccessAt?:string;
  window?:{ start:string; end:string };
  counts?:{ fixtures:number; predicted:number; skippedNoStandings:number };
  dataSources?:{ official:number; own:number; ai:number; elo:number; market?:number; resultsCollected:number; resultsLastDate?:string|null };
  api?:{ used:number; limit:number; fixturesSource?:string };
  absences?:{ api:number; ai:number; error?:string };
  market?:{ matched:number; requested:number };
  calibration?:{ n:number; tau:number; marketW:number };
  gemini?:{ used:boolean; model?:string; summarized:number; opinions?:number; opinionAgree?:number; error?:string };
}
export interface HitStat { n:number; acc:number|null }
/** Rekam jejak prediksi vs hasil sebenarnya (ditulis scripts/evaluate.ts ke public/data/calibration.json). */
export interface Calibration {
  version:1; updatedAt:string; n:number;
  acc:number|null; brier:number|null; logloss:number|null;
  uniform:{ brier:number; logloss:number };
  byLevel:Record<'high'|'medium'|'low', HitStat>;
  bins:{ label:string; n:number; acc:number|null; meanConf:number|null }[];
  ou25:HitStat; btts:HitStat;
  ai:{ agree:HitStat; disagree:HitStat; own?:HitStat; formulaSame?:HitStat; ou25?:HitStat; btts?:HitStat; hdp?:HitStat };
  market:{ n:number; llModel:number|null; llMarket:number|null; llBlend:number|null; bestW:number|null };
  tuning:{ tauRaw:number|null; tau:number; marketW:number; note:string };
  recent:{ home:string; away:string; pick:string; score:string; hit:boolean }[];
  /** Total benar per pasar + winrate gabungan (ditulis evaluate.ts; laga selesai saja). Kosong pada file lama. */
  totals?:{ x12:MarketTotal; ou25:MarketTotal; btts:MarketTotal; hdp:MarketTotal; hdpPush:number; overall:MarketTotal; combo3:MarketTotal; combo4:MarketTotal };
  /** Semua laga yang sudah dinilai, terbaru di atas (untuk halaman Riwayat). */
  history?:HistRow[];
}
export interface MarketTotal { n:number; hit:number; acc:number|null }
/** Satu baris riwayat: pilihan tiap pasar + benar/salahnya. hdp hanya ada bila laga itu punya pick HDP yang cukup tegas. */
export interface HistRow {
  id:number; ts:number; league?:string; home:string; away:string; score:string; conf:number;
  x12:{ pick:'1'|'X'|'2'; hit:boolean }; ou:{ pick:'over'|'under'; hit:boolean }; btts:{ pick:'yes'|'no'; hit:boolean };
  hdp?:{ side:'1'|'2'; line:number; res:'win'|'loss'|'push' };
  /** 1X2 + O/U 2.5 + BTTS benar semua */
  combo3:boolean;
  /** 1X2 + O/U 2.5 + BTTS + HDP benar semua; null bila tidak ada pick HDP atau HDP push */
  combo4:boolean|null;
}