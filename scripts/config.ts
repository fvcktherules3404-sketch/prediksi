const env = process.env;
// Liga yang diprediksi (ID API-Football). Ubah lewat env LEAGUE_IDS="39,140" atau ALL_LEAGUES=true
const DEFAULT_LEAGUES = [39,40,140,135,78,61,88,94,144,179,203,2,3,848,1,4,5,17,253,307,274,71,128,98,292];
export const CFG = {
  tzOffsetHours: 7,               // WIB
  windowStartHourWIB: 6,          // 06:00 WIB
  footballBase: 'https://v3.football.api-sports.io',
  dailyRequestLimit: Number(env.FOOTBALL_DAILY_LIMIT ?? 100), // free tier API-Football
  requestReserve: 8,              // sisa request yang tidak boleh dipakai
  maxStandingsRequests: 60,
  fixturesTtlH: 5, standingsTtlH: 20, maxStaleH: 72,
  allLeagues: env.ALL_LEAGUES === 'true',
  leagues: env.LEAGUE_IDS ? env.LEAGUE_IDS.split(',').map(Number).filter(Boolean) : DEFAULT_LEAGUES,
  geminiModel: env.GEMINI_MODEL ?? 'gemini-2.5-flash',
  geminiBatchSize: 15, geminiMaxCalls: 3,
  dataDir: 'public/data', cacheDir: 'data/cache',
};
