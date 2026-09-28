export interface Absence { name:string; pos:'GK'|'DEF'|'MID'|'FWD'|'?'; role:'key'|'starter'|'rotation'|'unknown'; status:'out'|'doubt'; reason?:string }
export interface AHLine { line:number; win:number; halfWin:number; push:number; halfLoss:number; loss:number; pCover:number; fairOdds:number }
export type DataSource = 'official'|'own'|'ai'|'elo';
export interface TeamInfo { id:number; name:string; logo?:string; rank?:number|null; form?:string|null; played:number; dataSource?:DataSource; elo?:number|null }
export interface Prediction {
  id:number; kickoff:string; timestamp:number;
  league:{ id:number; name:string; country?:string; logo?:string; round?:string; season:number };
  home:TeamInfo; away:TeamInfo;
  xg:{ home:number; away:number };
  probs:{ home:number; draw:number; away:number };
  fairOdds:{ home:number; draw:number; away:number };
  doubleChance:{ hx:number; xa:number; ha:number };
  ou:{ line:number; over:number; under:number }[];
  btts:{ yes:number; no:number };
  topScores:{ score:string; p:number }[];
  handicap:AHLine[]; fairHandicap:number;
  confidence:number; confidenceLevel:'high'|'medium'|'low';
  picks:{ result:string; pick1x2?:'1'|'X'|'2'; goals:string; safe?:string };
  aiSummary:string;
  absences?:{ home:Absence[]; away:Absence[]; source:'ai'|'api'|'both'; checked:boolean; adj:{ home:number; away:number } };
}
export interface PredictionsFile {
  version:number; generatedAt:string; window:{ start:string; end:string };
  ai:{ used:boolean; model?:string; summarized:number };
  api:{ used:number; limit:number };
  matches:Prediction[];
}
export interface Metadata {
  status:'ok'|'failed'|'partial'; message:string; generatedAt?:string; attemptedAt:string; lastSuccessAt?:string;
  window?:{ start:string; end:string };
  counts?:{ fixtures:number; predicted:number; skippedNoStandings:number };
  dataSources?:{ official:number; own:number; ai:number; elo:number; resultsCollected:number; resultsLastDate?:string|null };
  api?:{ used:number; limit:number; fixturesSource?:string };
  absences?:{ api:number; ai:number; error?:string };
  gemini?:{ used:boolean; model?:string; summarized:number; error?:string };
}
