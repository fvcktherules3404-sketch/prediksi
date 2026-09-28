export interface AHLine { line:number; win:number; halfWin:number; push:number; halfLoss:number; loss:number; pCover:number; fairOdds:number }
export interface TeamInfo { id:number; name:string; logo?:string; rank?:number|null; form?:string|null; played:number }
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
  picks:{ result:string; goals:string };
  aiSummary:string;
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
  api?:{ used:number; limit:number; fixturesSource?:string };
  gemini?:{ used:boolean; model?:string; summarized:number; error?:string };
}
